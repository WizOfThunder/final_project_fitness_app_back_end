const axios = require('axios');

async function reverseGeocode(latitude, longitude) {
  try {
    const res = await axios.get('https://nominatim.openstreetmap.org/reverse', {
      params: { lat: latitude, lon: longitude, format: 'json' },
      headers: { 'User-Agent': 'FitdaptiveApp/1.0' },
      timeout: 5000,
    });
    const addr = res.data?.address || {};
    const city = addr.city || addr.town || addr.village || addr.county || null;
    const country = addr.country || null;
    return { city, country };
  } catch {
    return { city: null, country: null };
  }
}

const WorkoutPlan = require('../workout/workout.model');
const DietPlan = require('./diet.model');
const User = require('../users/user.model');
const Exercise = require('../exercises/exercise.model');
const { askGemini } = require('../../config/gemini');
const { pool } = require('../../config/db');
const {enqueueJob, getJob, serializeJob} = require('./aiQueue');
const { saveNotification } = require('../notification/notification.helper');
const { sendPushNotification } = require('../notification/notification.service');

const WIB_CURRENT_DATE_SQL = `(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Jakarta')::date`;

const WORKOUT_REGEN_REASONS = {
  too_hard: 'Too hard',
  too_easy: 'Too easy',
  wrong_focus: 'Wrong focus area',
  repetitive: 'Too repetitive',
  equipment_mismatch: "Doesn't match my equipment",
  dislike_items: 'I dislike some exercises',
  other: 'Other',
};

const DIET_REGEN_REASONS = {
  wrong_goal: 'Does not match my goal',
  repetitive: 'Too repetitive',
  dislike_items: 'I dislike some meals',
  allergy_issue: 'Allergy or restriction issue',
  prep_time_issue: "Prep time doesn't fit",
  other: 'Other',
};

async function notifyAdminsAboutPlanValidation(user, plan, planType) {
  try {
    const [admins] = await pool.query("SELECT id, fcm_token FROM users WHERE role = 'admin'");
    const planLabel = planType === 'diet' ? 'Diet' : 'Workout';
    const title = `AI ${planLabel} Plan Submitted`;
    const body = `${user.name} submitted an AI-generated ${planLabel.toLowerCase()} plan for validation.`;
    const notificationData = {
      screen: 'AIRecommendationValidation',
      params: {},
      intent: 'admin_validation_request',
      actor_name: user.name,
      actor_role: user.role || 'member',
      plan_id: Number(plan.id),
      plan_type: planType,
      event_key: `admin:validation:${planType}:${plan.id}`,
    };

    for (const admin of admins) {
      await saveNotification(
        admin.id,
        title,
        body,
        'admin_validation_request',
        notificationData,
      );
      if (admin.fcm_token) {
        sendPushNotification(admin.fcm_token, title, body, {
          type: 'admin_validation_request',
          plan_id: String(plan.id),
          plan_type: planType,
          actor_name: user.name,
        }).catch(() => {});
      }
    }
  } catch (error) {
    console.error('[AI] Failed to notify admins about pending validation:', error.message);
  }
}

// Map survey fitness level to DB difficulty values
const DIFFICULTY_MAP = {
  'Beginner': 'beginner',
  'Intermediate': 'intermediate',
  'Advanced': 'expert',
};

// Map focus areas to DB muscle keywords
const FOCUS_MUSCLE_MAP = {
  'Upper body': ['chest', 'biceps', 'triceps', 'shoulders', 'traps', 'lats', 'middle_back', 'lower_back', 'neck', 'forearms'],
  'Lower body': ['quadriceps', 'hamstrings', 'glutes', 'calves', 'adductors', 'abductors'],
  'Core': ['abdominals', 'lower_back'],
  'Full body': null,
  'Unsure': null,
};

const FULL_GYM_EQUIPMENT_TERMS = [
  'barbell',
  'cable',
  'machine',
  'e-z curl bar',
  'ez curl',
  'kettlebell',
  'medicine ball',
  'exercise ball',
  'foam roll',
  'bench',
  'rack',
  'pull-up',
  'dip',
];

const EXERCISE_EQUIPMENT_BUCKETS = [
  'barbell',
  'dumbbell',
  'cable',
  'machine',
  'band',
  'kettlebell',
  'medicine ball',
  'exercise ball',
  'foam roll',
  'ez curl',
  'bench',
  'rack',
  'pull-up',
  'dip',
];

const EXERCISE_MOVEMENT_PATTERNS = [
  { bucket: 'push', pattern: /\b(press|push-?up|dip|fly|extension)\b/ },
  { bucket: 'pull', pattern: /\b(row|pull-?up|chin-?up|curl|pulldown|face pull)\b/ },
  { bucket: 'squat', pattern: /\b(squat|lunge|step-?up|leg press|split squat)\b/ },
  { bucket: 'hinge', pattern: /\b(deadlift|hip thrust|bridge|good morning|romanian)\b/ },
  { bucket: 'core', pattern: /\b(plank|crunch|sit-?up|twist|leg raise|hollow|mountain climber)\b/ },
  { bucket: 'conditioning', pattern: /\b(burpee|jump rope|sprint|run|jog|cycling|rowing)\b/ },
];

const WORKOUT_SAFETY_TEXT_PATTERNS = {
  back_pain: /\b(back|spine|spinal|disc|lumbar|sciatica)\b/,
  knee_issues: /\b(knee|acl|mcl|meniscus|patella|patellar)\b/,
  shoulder_issue: /\b(shoulder|rotator cuff|impingement|labrum)\b/,
  ankle_issue: /\b(ankle|achilles|foot|plantar)\b/,
  wrist_elbow_issue: /\b(wrist|elbow|forearm|carpal|tennis elbow|golfer'?s elbow)\b/,
  stimulant_sensitive: /\b(stimulant|adderall|ritalin|vyvanse|amphetamine|methylphenidate)\b/,
  diabetes_medication: /\b(diabetes|insulin|metformin|glucose)\b/,
  heart_sensitive: /\b(heart|cardiac|blood pressure|hypertension|arrhythmia)\b/,
  weight_loss_medication: /\b(weight[- ]?loss|semaglutide|ozempic|wegovy|tirzepatide|mounjaro)\b/,
  hormonal_support: /\b(hormonal|trt|testosterone|anabolic|steroid)\b/,
};

const WORKOUT_RISK_TAG_PENALTIES = {
  back_pain: {
    hardBlock: ['loaded_hinge', 'forward_hinge_loading', 'high_impact_explosive'],
    soft: {
      high_bracing: 4,
      trunk_rotation: 3,
      cardio_density: 1,
    },
    prompt: 'Keep the plan back-friendly: avoid loaded hinging, high-impact explosive work, and aggressive trunk loading.',
  },
  knee_issues: {
    hardBlock: ['high_impact_explosive'],
    soft: {
      knee_dominant: 4,
      single_leg_balance: 3,
      cardio_density: 1,
    },
    prompt: 'Keep the plan knee-friendly: prefer low-impact choices and be conservative with deep knee loading and unstable single-leg work.',
  },
  shoulder_issue: {
    hardBlock: ['overhead_loading'],
    soft: {
      upper_push: 3,
      upper_pull: 1,
    },
    prompt: 'Keep the plan shoulder-friendly: avoid overhead loading and be conservative with pressing volume.',
  },
  ankle_issue: {
    hardBlock: ['high_impact_explosive'],
    soft: {
      single_leg_balance: 2,
      cardio_density: 1,
    },
    prompt: 'Keep the plan ankle-friendly: avoid impact-heavy work and minimize unstable single-leg demands.',
  },
  wrist_elbow_issue: {
    hardBlock: [],
    soft: {
      upper_push: 2,
      upper_pull: 2,
    },
    prompt: 'Keep the plan joint-friendly for the arms: be conservative with heavy gripping, pressing, and pulling volume.',
  },
  stimulant_sensitive: {
    hardBlock: [],
    soft: {
      cardio_density: 3,
      high_impact_explosive: 2,
    },
    prompt: 'Avoid unnecessarily extreme conditioning spikes because stimulant factors may raise heart rate and perceived effort.',
  },
  diabetes_medication: {
    hardBlock: [],
    soft: {
      cardio_density: 2,
      high_impact_explosive: 1,
    },
    prompt: 'Favor predictable moderate-intensity work over highly erratic conditioning bursts.',
  },
  heart_sensitive: {
    hardBlock: [],
    soft: {
      cardio_density: 4,
      high_impact_explosive: 4,
      high_bracing: 4,
      long_isometric: 4,
    },
    prompt: 'Keep intensity cardiovascularly conservative: avoid spike-heavy conditioning, long holds, and hard bracing efforts.',
  },
  weight_loss_medication: {
    hardBlock: [],
    soft: {
      cardio_density: 2,
      high_impact_explosive: 1,
    },
    prompt: 'Favor steady, lower-nausea training over harsh conditioning spikes.',
  },
  hormonal_support: {
    hardBlock: [],
    soft: {},
    prompt: 'Do not auto-escalate intensity or recovery demands because of hormonal support factors.',
  },
};

function buildExerciseSelectionContext(
  {
    fitnessLevel,
    equipment,
    equipmentOther,
    focusAreas,
    planDays,
    healthConditions,
    healthConditionsOther,
    medicationFactors,
    medicationFactorsOther,
  },
  previousPlan,
) {
  const difficulty = DIFFICULTY_MAP[fitnessLevel] || 'beginner';
  const cleanEquipment = (equipment || []).filter(e => e !== 'None');
  const hasGym = cleanEquipment.includes('Full gym');
  const equipmentList = [];
  const exactEquipment = [];
  if (!cleanEquipment.length) equipmentList.push('body only', '');
  if (cleanEquipment.includes('Dumbbells')) {
    equipmentList.push('dumbbell');
    exactEquipment.push('dumbbell');
  }
  if (cleanEquipment.includes('Resistance bands')) {
    equipmentList.push('band');
    exactEquipment.push('band');
  }
  if (hasGym) {
    equipmentList.push(...FULL_GYM_EQUIPMENT_TERMS, 'other');
    exactEquipment.push(...FULL_GYM_EQUIPMENT_TERMS);
  }
  if (equipmentOther) {
    equipmentList.push(equipmentOther.toLowerCase());
    exactEquipment.push(equipmentOther.toLowerCase());
  }
  equipmentList.push('');

  const cleanFocus = (focusAreas || []).filter(f => f !== 'Full body' && f !== 'Unsure');
  let allowedMuscles = null;
  if (cleanFocus.length) {
    allowedMuscles = new Set();
    for (const area of cleanFocus) {
      const muscles = FOCUS_MUSCLE_MAP[area];
      if (muscles) muscles.forEach(m => allowedMuscles.add(m));
    }
  }

  const previousItems = previousPlan?.items || [];
  const previousExerciseNames = new Set(
    previousItems
      .map(item => String(item.name || '').toLowerCase())
      .filter(Boolean),
  );
  const previousMuscles = new Set(
    previousItems
      .map(item => String(item.muscle || '').toLowerCase())
      .filter(Boolean),
  );
  const safetyProfile = buildWorkoutSafetyProfile({
    healthConditions,
    healthConditionsOther,
    medicationFactors,
    medicationFactorsOther,
  });

  return {
    difficulty,
    cleanEquipment,
    equipmentList: Array.from(new Set(equipmentList)),
    exactEquipment: Array.from(new Set(exactEquipment)),
    allowedMuscles,
    previousExerciseNames,
    previousMuscles,
    hardBlockedRiskTags: safetyProfile.hardBlockedRiskTags,
    softPenaltyByTag: safetyProfile.softPenaltyByTag,
    candidateLimit: Math.min(30, Math.max(18, (planDays?.length || 5) * 6)),
  };
}

function filterExercises(allExercises, context) {
  return allExercises.filter(e => {
    const diffOk = e.difficulty === context.difficulty;
    const equip = (e.equipment || '').toLowerCase();
    const equipOk = equip === '' || context.equipmentList.some(eq => eq !== '' && equip.includes(eq));
    const muscleOk = !context.allowedMuscles || context.allowedMuscles.has((e.muscle || '').toLowerCase());
    const riskTags = inferExerciseRiskTags(e);
    const riskOk = !hasBlockedRiskTag(riskTags, context.hardBlockedRiskTags);
    return diffOk && equipOk && muscleOk && riskOk;
  });
}

function inferExerciseMovementBucket(exercise) {
  const name = String(exercise?.name || '').toLowerCase();
  for (const candidate of EXERCISE_MOVEMENT_PATTERNS) {
    if (candidate.pattern.test(name)) return candidate.bucket;
  }

  const muscle = String(exercise?.muscle || '').toLowerCase();
  if (['chest', 'triceps', 'shoulders'].includes(muscle)) return 'push';
  if (['biceps', 'forearms', 'lats', 'middle_back', 'traps'].includes(muscle)) return 'pull';
  if (['quadriceps', 'adductors', 'abductors'].includes(muscle)) return 'squat';
  if (['hamstrings', 'glutes', 'calves'].includes(muscle)) return 'hinge';
  if (['abdominals', 'lower_back'].includes(muscle)) return 'core';
  return 'other';
}

function incrementPenalty(penaltyMap, tag, value) {
  penaltyMap.set(tag, (penaltyMap.get(tag) || 0) + value);
}

function detectWorkoutSafetyFlags(surveyData = {}) {
  const flags = new Set();
  const healthConditions = (surveyData.healthConditions || []).map(value => String(value).toLowerCase());
  const medicationFactors = (surveyData.medicationFactors || []).map(value => String(value).toLowerCase());
  const freeText = [
    surveyData.healthConditionsOther,
    surveyData.medicationFactorsOther,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (healthConditions.includes('back pain') || WORKOUT_SAFETY_TEXT_PATTERNS.back_pain.test(freeText)) {
    flags.add('back_pain');
  }
  if (healthConditions.includes('knee issues') || WORKOUT_SAFETY_TEXT_PATTERNS.knee_issues.test(freeText)) {
    flags.add('knee_issues');
  }
  if (WORKOUT_SAFETY_TEXT_PATTERNS.shoulder_issue.test(freeText)) {
    flags.add('shoulder_issue');
  }
  if (WORKOUT_SAFETY_TEXT_PATTERNS.ankle_issue.test(freeText)) {
    flags.add('ankle_issue');
  }
  if (WORKOUT_SAFETY_TEXT_PATTERNS.wrist_elbow_issue.test(freeText)) {
    flags.add('wrist_elbow_issue');
  }

  if (
    medicationFactors.includes('stimulant medication')
    || WORKOUT_SAFETY_TEXT_PATTERNS.stimulant_sensitive.test(freeText)
  ) {
    flags.add('stimulant_sensitive');
  }
  if (
    medicationFactors.includes('diabetes medication')
    || WORKOUT_SAFETY_TEXT_PATTERNS.diabetes_medication.test(freeText)
  ) {
    flags.add('diabetes_medication');
  }
  if (
    medicationFactors.includes('blood pressure / heart medication')
    || WORKOUT_SAFETY_TEXT_PATTERNS.heart_sensitive.test(freeText)
  ) {
    flags.add('heart_sensitive');
  }
  if (
    medicationFactors.includes('weight-loss medication')
    || WORKOUT_SAFETY_TEXT_PATTERNS.weight_loss_medication.test(freeText)
  ) {
    flags.add('weight_loss_medication');
  }
  if (
    medicationFactors.includes('hormonal / trt / anabolic')
    || WORKOUT_SAFETY_TEXT_PATTERNS.hormonal_support.test(freeText)
  ) {
    flags.add('hormonal_support');
  }

  return flags;
}

function buildWorkoutSafetyProfile(surveyData = {}) {
  const activeFlags = Array.from(detectWorkoutSafetyFlags(surveyData));
  const hardBlockedRiskTags = new Set();
  const softPenaltyByTag = new Map();
  const promptNotes = [];

  for (const flag of activeFlags) {
    const config = WORKOUT_RISK_TAG_PENALTIES[flag];
    if (!config) continue;

    config.hardBlock.forEach(tag => hardBlockedRiskTags.add(tag));
    Object.entries(config.soft).forEach(([tag, value]) => {
      incrementPenalty(softPenaltyByTag, tag, value);
    });
    if (config.prompt) promptNotes.push(config.prompt);
  }

  return {
    activeFlags,
    hardBlockedRiskTags,
    softPenaltyByTag,
    promptNotes,
  };
}

function inferExerciseRiskTags(exercise) {
  const tags = new Set();
  const name = String(exercise?.name || '').toLowerCase();
  const equipment = String(exercise?.equipment || '').toLowerCase();
  const movement = inferExerciseMovementBucket(exercise);

  if (movement === 'conditioning') tags.add('cardio_density');
  if (/\b(jump|box jump|plyo|burpee|sprint|bounding|skater hop|tuck jump|jump rope)\b/.test(name)) {
    tags.add('high_impact_explosive');
  }
  if (/\b(clean|snatch|jerk|push press|thruster|kettlebell swing)\b/.test(name)) {
    tags.add('high_impact_explosive');
  }
  if (/\b(overhead|shoulder press|military press|arnold press|push press|thruster|snatch|jerk)\b/.test(name)) {
    tags.add('overhead_loading');
  }
  if (/\b(deadlift|romanian|rdl|good morning|hip hinge|kettlebell swing)\b/.test(name)) {
    tags.add('loaded_hinge');
  }
  if (/\b(deadlift|romanian|rdl|good morning|bent-over|t-bar row|barbell row|clean|snatch)\b/.test(name)) {
    tags.add('forward_hinge_loading');
  }
  if (
    (equipment.includes('barbell') || equipment.includes('rack') || equipment.includes('machine'))
    && /\b(squat|leg press|deadlift|good morning|row|press)\b/.test(name)
  ) {
    tags.add('high_bracing');
  }
  if (/\b(squat|lunge|split squat|step-?up|leg press|wall sit|pistol)\b/.test(name)) {
    tags.add('knee_dominant');
  }
  if (/\b(lunge|split squat|step-?up|pistol|single-leg|single leg)\b/.test(name)) {
    tags.add('single_leg_balance');
  }
  if (/\b(plank|wall sit|hollow hold|hold|isometric)\b/.test(name)) {
    tags.add('long_isometric');
  }
  if (/\b(twist|woodchop|wood chop|russian)\b/.test(name)) {
    tags.add('trunk_rotation');
  }
  if (/\b(run|jog|sprint|burpee|jump rope|rowing|cycling|mountain climber|high knees)\b/.test(name)) {
    tags.add('cardio_density');
  }
  if (/\b(dip|push-?up|press|fly)\b/.test(name) || movement === 'push') {
    tags.add('upper_push');
  }
  if (/\b(row|pull-?up|chin-?up|pulldown|curl|face pull)\b/.test(name) || movement === 'pull') {
    tags.add('upper_pull');
  }

  return tags;
}

function hasBlockedRiskTag(riskTags, blockedTags) {
  for (const tag of riskTags) {
    if (blockedTags.has(tag)) return true;
  }

  return false;
}

function getExerciseEquipmentBucket(equipment) {
  const normalized = String(equipment || '').toLowerCase();
  if (!normalized) return 'bodyweight';

  const match = EXERCISE_EQUIPMENT_BUCKETS.find(bucket => normalized.includes(bucket));
  return match || normalized;
}

function scoreExercise(exercise, context) {
  const muscle = String(exercise.muscle || '').toLowerCase();
  const equipment = String(exercise.equipment || '').toLowerCase();
  const name = String(exercise.name || '').toLowerCase();
  const riskTags = inferExerciseRiskTags(exercise);
  let score = 0;

  if (context.allowedMuscles?.has(muscle)) score += 4;

  if (!context.cleanEquipment.length && equipment === '') score += 4;
  else if (context.exactEquipment.some(term => equipment.includes(term))) score += 3;
  else if (equipment === '') score += 1;

  if (context.previousExerciseNames.has(name)) score -= 6;
  if (context.previousMuscles.has(muscle)) score -= 2;
  for (const tag of riskTags) {
    score -= context.softPenaltyByTag.get(tag) || 0;
  }

  return score;
}

function incrementCounter(counterMap, key) {
  counterMap.set(key, (counterMap.get(key) || 0) + 1);
}

function diversifyExercises(sortedExercises, candidateLimit) {
  const selected = [];
  const deferred = [];
  const selectedIds = new Set();
  const muscleCounts = new Map();
  const movementCounts = new Map();
  const equipmentCounts = new Map();
  const maxPerMuscle = Math.max(2, Math.ceil(candidateLimit / 6));
  const maxPerMovement = Math.max(2, Math.ceil(candidateLimit / 5));
  const maxPerEquipment = Math.max(3, Math.ceil(candidateLimit / 3));

  const addExercise = exercise => {
    selected.push(exercise);
    selectedIds.add(exercise.id);
    incrementCounter(muscleCounts, String(exercise.muscle || '').toLowerCase() || 'other');
    incrementCounter(movementCounts, inferExerciseMovementBucket(exercise));
    incrementCounter(equipmentCounts, getExerciseEquipmentBucket(exercise.equipment));
  };

  for (const exercise of sortedExercises) {
    const muscleKey = String(exercise.muscle || '').toLowerCase() || 'other';
    const movementKey = inferExerciseMovementBucket(exercise);
    const equipmentKey = getExerciseEquipmentBucket(exercise.equipment);

    if (
      (muscleCounts.get(muscleKey) || 0) >= maxPerMuscle
      || (movementCounts.get(movementKey) || 0) >= maxPerMovement
      || (equipmentCounts.get(equipmentKey) || 0) >= maxPerEquipment
    ) {
      deferred.push(exercise);
      continue;
    }

    addExercise(exercise);
    if (selected.length >= candidateLimit) return selected;
  }

  for (const exercise of deferred) {
    if (selectedIds.has(exercise.id)) continue;
    addExercise(exercise);
    if (selected.length >= candidateLimit) break;
  }

  return selected;
}

function selectExercises(allExercises, criteria, previousPlan) {
  const context = buildExerciseSelectionContext(criteria, previousPlan);
  const filtered = filterExercises(allExercises, context);

  return diversifyExercises(
    filtered
      .map(exercise => ({
        ...exercise,
        _selectionScore: scoreExercise(exercise, context),
      }))
      .sort((a, b) => {
        if (b._selectionScore !== a._selectionScore) {
          return b._selectionScore - a._selectionScore;
        }

        return String(a.name || '').localeCompare(String(b.name || ''));
      }),
    context.candidateLimit,
  ).slice(0, context.candidateLimit);
}

function calcAge(dob) {
  if (!dob) return null;
  const birth = new Date(dob);
  const today = new Date();
  let age = today.getFullYear() - birth.getFullYear();
  const m = today.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
  return age;
}

function normalizeWorkoutSurveyData(body = {}) {
  return {
    ...body,
    healthConditionsOther:
      typeof body.healthConditionsOther === 'string'
        ? body.healthConditionsOther.trim()
        : '',
    medicationFactorsOther:
      typeof body.medicationFactorsOther === 'string'
        ? body.medicationFactorsOther.trim()
        : '',
    additionalNote: typeof body.additionalNote === 'string'
      ? body.additionalNote.trim()
      : '',
  };
}

function buildWorkoutSurveyInputForStorage(surveyData) {
  const surveyInput = {
    ...surveyData,
    equipmentOther: surveyData.equipmentOther || null,
    healthConditionsOther: surveyData.healthConditionsOther || null,
    medicationFactorsOther: surveyData.medicationFactorsOther || null,
    additionalNote: surveyData.additionalNote || null,
    regenerationFeedback: surveyData.regenerationFeedback || null,
    regeneratedFromPlanId: surveyData.previousPlanId || null,
  };

  delete surveyInput.previousPlanId;

  return surveyInput;
}

function formatPromptDate(value) {
  return value ? String(value).slice(0, 10) : null;
}

async function getRecentWorkoutActivitySummary(userId) {
  const [[summary]] = await pool.query(`
    SELECT
      COUNT(*) AS synced_days,
      MAX(date) AS last_synced_date,
      COALESCE(ROUND(AVG(steps)), 0) AS avg_steps,
      COALESCE(SUM(exercise_minutes), 0) AS total_exercise_minutes,
      COUNT(*) FILTER (WHERE sleep_hours > 0) AS sleep_days,
      COALESCE(ROUND(AVG(NULLIF(sleep_hours, 0)), 1), 0) AS avg_sleep_hours,
      COALESCE(SUM(CASE WHEN workout_completed = TRUE THEN 1 ELSE 0 END), 0) AS workout_completed_days
    FROM activity_logs
    WHERE user_id = ?
      AND date >= ${WIB_CURRENT_DATE_SQL} - INTERVAL '6 days'
      AND date <= ${WIB_CURRENT_DATE_SQL}
  `, [userId]);

  const syncedDays = Number(summary?.synced_days) || 0;
  if (!syncedDays) {
    return '';
  }

  const sleepDays = Number(summary.sleep_days) || 0;
  const avgSleepHours = Number(summary.avg_sleep_hours) || 0;

  return [
    'Recent 7-day activity summary from app activity logs:',
    `- Synced days: ${syncedDays}/7`,
    `- Last sync date: ${formatPromptDate(summary.last_synced_date) || 'unknown'}`,
    `- Avg steps on synced days: ${Math.round(Number(summary.avg_steps) || 0)}`,
    `- Total exercise minutes: ${Math.round(Number(summary.total_exercise_minutes) || 0)}`,
    sleepDays > 0
      ? `- Avg sleep on days with sleep data: ${avgSleepHours.toFixed(1)} hours`
      : '- Avg sleep on days with sleep data: not enough data',
    `- Workout-complete days: ${Number(summary.workout_completed_days) || 0}/7`,
  ].join('\n');
}

async function getRecentDietActivityNote(userId) {
  const [[summary]] = await pool.query(`
    SELECT
      COUNT(*) AS synced_days,
      COALESCE(SUM(exercise_minutes), 0) AS total_exercise_minutes,
      COUNT(*) FILTER (WHERE sleep_hours > 0) AS sleep_days,
      COALESCE(ROUND(AVG(NULLIF(sleep_hours, 0)), 1), 0) AS avg_sleep_hours,
      COALESCE(SUM(CASE WHEN workout_completed = TRUE THEN 1 ELSE 0 END), 0) AS workout_completed_days
    FROM activity_logs
    WHERE user_id = ?
      AND date >= ${WIB_CURRENT_DATE_SQL} - INTERVAL '6 days'
      AND date <= ${WIB_CURRENT_DATE_SQL}
  `, [userId]);

  const syncedDays = Number(summary?.synced_days) || 0;
  if (!syncedDays) {
    return '';
  }

  const sleepDays = Number(summary.sleep_days) || 0;
  const avgSleepHours = Number(summary.avg_sleep_hours) || 0;

  return [
    'Recent 7-day activity note from app activity logs:',
    `- Synced days: ${syncedDays}/7`,
    `- Total exercise minutes: ${Math.round(Number(summary.total_exercise_minutes) || 0)}`,
    sleepDays > 0
      ? `- Avg sleep on days with sleep data: ${avgSleepHours.toFixed(1)} hours`
      : '- Avg sleep on days with sleep data: not enough data',
    `- Workout-complete days: ${Number(summary.workout_completed_days) || 0}/7`,
  ].join('\n');
}

function normalizeDietSurveyData(body = {}) {
  const preferredCuisines = Array.isArray(body.preferredCuisines)
    ? body.preferredCuisines
        .map(value => (typeof value === 'string' ? value.trim() : ''))
        .filter(Boolean)
    : [];
  const uniquePreferredCuisines = Array.from(new Set(preferredCuisines));
  const sanitizedPreferredCuisines = uniquePreferredCuisines.length
    ? uniquePreferredCuisines.includes('Any') && uniquePreferredCuisines.length > 1
      ? uniquePreferredCuisines.filter(value => value !== 'Any')
      : uniquePreferredCuisines
    : ['Any'];
  const planDays = getDietPlanDays(body);

  return {
    ...body,
    goal: typeof body.goal === 'string' ? body.goal.trim() : body.goal,
    dietType: typeof body.dietType === 'string' ? body.dietType.trim() : body.dietType,
    preferredCuisines: sanitizedPreferredCuisines,
    planDays,
    availableIngredients: normalizeDietPreferenceList(body.availableIngredients),
    availableTools: normalizeDietPreferenceList(body.availableTools),
    allergiesOther:
      typeof body.allergiesOther === 'string'
        ? body.allergiesOther.trim()
        : '',
    flexibleMealDetails:
      typeof body.flexibleMealDetails === 'string'
        ? body.flexibleMealDetails.trim()
        : '',
    additionalNote: typeof body.additionalNote === 'string'
      ? body.additionalNote.trim()
      : '',
  };
}

function buildDietSurveyInputForStorage(surveyData, location) {
  const surveyInput = {
    ...surveyData,
    planDays: getDietPlanDays(surveyData).map(formatPlanDay),
    flexibleMealDetails: surveyData.flexibleMealDetails || null,
    additionalNote: surveyData.additionalNote || null,
    location,
    regenerationFeedback: surveyData.regenerationFeedback || null,
    regeneratedFromPlanId: surveyData.previousPlanId || null,
  };

  delete surveyInput.previousPlanId;
  delete surveyInput.latitude;
  delete surveyInput.longitude;

  return surveyInput;
}

const DIET_PLAN_DAYS = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
];

const CHEAT_DAY_PREFERENCE_MAP = {
  '1 cheat day per week': ['saturday'],
  '2 cheat days per week': ['saturday', 'sunday'],
};

const DIET_ALLERGY_INGREDIENT_PATTERNS = {
  dairy: /\b(milk|cheese|cream|butter|yogurt)\b/,
  nuts: /\b(nut|almond|cashew|walnut|pecan|pistachio)\b/,
};

const CUSTOM_ALLERGY_SYNONYM_GROUPS = [
  ['shrimp', 'prawn'],
  ['chili', 'chilli'],
  ['soy', 'tofu', 'soy sauce', 'edamame'],
];
const OPTIONAL_DIET_PREFERENCE_EMPTY_VALUES = new Set([
  'none',
  'no',
  'n/a',
  'na',
  'not sure',
  'unsure',
]);
const AVAILABLE_TOOL_SYNONYM_GROUPS = [
  ['stove', 'stovetop', 'pan', 'skillet', 'pot', 'saucepan', 'wok'],
  ['oven', 'bake', 'baked', 'roast', 'roasted', 'broil'],
  ['microwave'],
  ['blender', 'blend', 'blended'],
  ['air fryer', 'airfryer'],
  ['grill', 'grilled', 'griddle'],
  ['slow cooker', 'crockpot'],
];
const RECIPE_TOOL_HINTS = [
  {
    label: 'stove',
    pattern: /\b(stove|stovetop|skillet|pan|pot|saucepan|wok|boil|simmer|saute|stir(?: |-)?fry)\b/,
  },
  {
    label: 'oven',
    pattern: /\b(oven|bake|baked|roast|roasted|broil|preheat)\b/,
  },
  {
    label: 'microwave',
    pattern: /\bmicrowave\b/,
  },
  {
    label: 'blender',
    pattern: /\b(blender|blend|blended)\b/,
  },
  {
    label: 'air fryer',
    pattern: /\bair ?fryer\b/,
  },
  {
    label: 'grill',
    pattern: /\b(grill|grilled|griddle)\b/,
  },
  {
    label: 'slow cooker',
    pattern: /\b(slow cooker|crockpot)\b/,
  },
];

const RECIPE_STRICT_SNACK_PATTERN = /\b(smoothie|shake|juice)\b/;
const RECIPE_SNACK_PATTERN = /\b(bars?|bites?|trail mix|parfait|muffin|cookie|brownie|fruit cup|energy balls?|protein balls?)\b/;
const RECIPE_MEAL_PATTERN = /\b(egg|eggs|omelet|omelette|oatmeal|oats|toast|pancake|rice|pasta|noodle|soup|curry|stir(?: |-)?fry|salad|sandwich|wrap|bowl|chicken|beef|steak|salmon|fish|tofu)\b/;
const RECIPE_LIGHT_SNACK_PATTERN = /\b(fruit|berries?|apple|banana|orange|grape|nuts?|seeds?|crackers?)\b/;

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildRecipeIngredientText(recipe) {
  if (!Array.isArray(recipe.ingredients)) return '';

  return recipe.ingredients
    .map(ingredient => {
      if (typeof ingredient === 'string') return ingredient;
      return typeof ingredient?.name === 'string' ? ingredient.name : '';
    })
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function summarizeRecipeIngredients(recipe, limit = 6) {
  if (!Array.isArray(recipe.ingredients)) return '';

  return recipe.ingredients
    .map(ingredient => {
      if (typeof ingredient === 'string') return ingredient;
      return typeof ingredient?.name === 'string' ? ingredient.name : '';
    })
    .map(name => String(name).trim())
    .filter(Boolean)
    .slice(0, limit)
    .join(', ');
}

function buildRecipePreparationText(recipe) {
  const title = String(recipe?.title || '').toLowerCase();
  const tags = Array.isArray(recipe?.tags)
    ? recipe.tags.map(tag => String(tag).toLowerCase()).join(' ')
    : '';
  const instructions = Array.isArray(recipe?.instructions)
    ? recipe.instructions.map(step => String(step).toLowerCase()).join(' ')
    : typeof recipe?.instructions === 'string'
    ? recipe.instructions.toLowerCase()
    : '';

  return `${title} ${tags} ${instructions}`.trim();
}

function extractRecipeToolHints(recipe) {
  const text = buildRecipePreparationText(recipe);

  return RECIPE_TOOL_HINTS
    .filter(tool => tool.pattern.test(text))
    .map(tool => tool.label);
}

function buildRecipeUsageText(recipe) {
  const title = String(recipe?.title || '').toLowerCase();
  const ingredientText = buildRecipeIngredientText(recipe);
  const tags = Array.isArray(recipe?.tags)
    ? recipe.tags.map(tag => String(tag).toLowerCase()).join(' ')
    : '';

  return `${title} ${ingredientText} ${tags}`.trim();
}

function classifyRecipeUsage(recipe) {
  const text = buildRecipeUsageText(recipe);
  const calories = Number(recipe?.calories) || 0;

  if (RECIPE_STRICT_SNACK_PATTERN.test(text)) return 'snack';
  if (RECIPE_MEAL_PATTERN.test(text)) return 'meal';
  if (RECIPE_SNACK_PATTERN.test(text)) return 'snack';
  if (calories > 0 && calories <= 250 && RECIPE_LIGHT_SNACK_PATTERN.test(text)) {
    return 'snack';
  }

  return 'meal';
}

function isSnackMealType(mealType) {
  return ['snack', 'morning_snack', 'afternoon_snack'].includes(
    String(mealType || '').toLowerCase(),
  );
}

function splitDelimitedTextList(value) {
  if (typeof value !== 'string') return [];

  return value
    .replace(/\band\b/gi, ',')
    .split(/[,\n;/]+/)
    .map(entry => entry.trim().replace(/\s+/g, ' '))
    .filter(Boolean);
}

function normalizeDelimitedTextList(value) {
  return splitDelimitedTextList(value).map(entry => entry.toLowerCase());
}

function normalizeDietPreferenceList(value) {
  const entries = Array.isArray(value)
    ? value.flatMap(entry => splitDelimitedTextList(entry))
    : splitDelimitedTextList(value);
  const seen = new Set();

  return entries
    .filter(entry => {
      const normalized = entry.toLowerCase();
      if (!normalized || OPTIONAL_DIET_PREFERENCE_EMPTY_VALUES.has(normalized)) {
        return false;
      }

      if (seen.has(normalized)) {
        return false;
      }

      seen.add(normalized);
      return true;
    })
    .slice(0, 20);
}

function normalizeCustomAllergyTerms(value) {
  const expandedTerms = new Set();

  for (const term of normalizeDelimitedTextList(value)) {
    expandedTerms.add(term);

    for (const group of CUSTOM_ALLERGY_SYNONYM_GROUPS) {
      if (group.includes(term)) {
        group.forEach(alias => expandedTerms.add(alias));
      }
    }
  }

  return Array.from(expandedTerms).sort((a, b) => b.length - a.length);
}

function buildCustomAllergyPatterns(value) {
  return normalizeCustomAllergyTerms(value).map(
    term => new RegExp(`\\b${escapeRegExp(term)}\\b`),
  );
}

function getRecipePrepTimeLimit(prepTime) {
  const normalized = typeof prepTime === 'string' ? prepTime.trim().toLowerCase() : '';

  if (!normalized || normalized === 'no time limit') return null;
  if (normalized.includes('10') && normalized.includes('30')) return 30;
  if (normalized.includes('30 minutes') && normalized.includes('1 hour')) return 60;
  if (normalized.includes('1 hour') && normalized.includes('2 hours')) return 120;

  return null;
}

function normalizeDietGoal(goal, dietType) {
  const goalText = String(goal || '').toLowerCase();
  const dietTypeText = String(dietType || '').toLowerCase();

  if (dietTypeText.includes('keto') || goalText.includes('keto')) return 'keto';
  if (goalText.includes('muscle')) return 'muscle_gain';
  if (goalText.includes('weight') || goalText.includes('loss') || goalText.includes('fat')) return 'weight_loss';
  if (goalText.includes('maint')) return 'maintenance';
  if (goalText.includes('health')) return 'eat_healthier';

  return 'general';
}

function scoreBalancedRecipeMacros(recipe) {
  const proteinCalories = (Number(recipe.protein) || 0) * 4;
  const carbCalories = (Number(recipe.carbs) || 0) * 4;
  const fatCalories = (Number(recipe.fat) || 0) * 9;
  const totalMacroCalories = proteinCalories + carbCalories + fatCalories;

  if (totalMacroCalories <= 0) return 0;

  const proteinRatio = proteinCalories / totalMacroCalories;
  const carbRatio = carbCalories / totalMacroCalories;
  const fatRatio = fatCalories / totalMacroCalories;
  const distance =
    Math.abs(proteinRatio - 0.25)
    + Math.abs(carbRatio - 0.45)
    + Math.abs(fatRatio - 0.30);

  return Math.max(0, 20 - distance * 30);
}

function scoreRecipe(recipe, goalType) {
  const calories = Number(recipe.calories) || 0;
  const protein = Number(recipe.protein) || 0;
  const carbs = Number(recipe.carbs) || 0;
  const fat = Number(recipe.fat) || 0;
  const prepMinutes = Number(recipe.ready_in_minutes) || 0;
  let score = 0;

  switch (goalType) {
    case 'muscle_gain':
      score += protein * 3;
      if (calories >= 350 && calories <= 900) score += 10;
      break;
    case 'weight_loss':
      score += calories > 0 ? (protein / calories) * 1200 : protein * 2;
      if (calories > 650) score -= (calories - 650) * 0.03;
      break;
    case 'maintenance':
    case 'eat_healthier':
      score += scoreBalancedRecipeMacros(recipe);
      score += protein;
      break;
    case 'keto':
      score += protein * 1.5;
      score += fat;
      score -= carbs * 5;
      break;
    default:
      score += protein * 1.5;
      score += scoreBalancedRecipeMacros(recipe) / 2;
      break;
  }

  if (prepMinutes > 0) score -= prepMinutes * 0.05;

  return score;
}

function buildSoftPreferencePatterns(values = []) {
  return values.map(value => ({
    value: String(value).toLowerCase(),
    pattern: new RegExp(`\\b${escapeRegExp(String(value).toLowerCase())}\\b`),
  }));
}

function buildToolPreferencePatterns(values = []) {
  const expandedTerms = new Set();

  for (const rawValue of values) {
    const normalized = String(rawValue || '').trim().toLowerCase();
    if (!normalized) continue;

    expandedTerms.add(normalized);
    for (const group of AVAILABLE_TOOL_SYNONYM_GROUPS) {
      if (group.includes(normalized)) {
        group.forEach(alias => expandedTerms.add(alias));
      }
    }
  }

  return buildSoftPreferencePatterns(
    Array.from(expandedTerms).sort((a, b) => b.length - a.length),
  );
}

function countPatternMatches(text, patterns = []) {
  if (!text || patterns.length === 0) return 0;

  let matches = 0;
  for (const {pattern} of patterns) {
    if (pattern.test(text)) {
      matches += 1;
    }
  }

  return matches;
}

function scoreRecipeIngredientPreference(recipe, patterns = []) {
  if (patterns.length === 0) return 0;

  const matches = countPatternMatches(buildRecipeIngredientText(recipe), patterns);
  if (matches === 0) return 0;

  return matches * 14 + (matches / patterns.length) * 18;
}

function scoreRecipeToolPreference(recipe, patterns = []) {
  if (patterns.length === 0) return 0;

  const matches = countPatternMatches(buildRecipePreparationText(recipe), patterns);
  if (matches === 0) return 0;

  return matches * 8;
}

function selectRecipes(allRecipes, criteria) {
  const filtered = filterRecipes(allRecipes, criteria);
  const goalType = normalizeDietGoal(criteria.goal, criteria.dietType);
  const ingredientPreferencePatterns = buildSoftPreferencePatterns(
    criteria.availableIngredients || [],
  );
  const toolPreferencePatterns = buildToolPreferencePatterns(
    criteria.availableTools || [],
  );

  return filtered
    .map(recipe => {
      const ingredientPreferenceScore = scoreRecipeIngredientPreference(
        recipe,
        ingredientPreferencePatterns,
      );
      const toolPreferenceScore = scoreRecipeToolPreference(
        recipe,
        toolPreferencePatterns,
      );

      return {
        ...recipe,
        _usageKind: classifyRecipeUsage(recipe),
        _selectionScore:
          scoreRecipe(recipe, goalType)
          + ingredientPreferenceScore
          + toolPreferenceScore,
      };
    })
    .sort((a, b) => {
      if (b._selectionScore !== a._selectionScore) {
        return b._selectionScore - a._selectionScore;
      }

      return (Number(a.ready_in_minutes) || 0) - (Number(b.ready_in_minutes) || 0);
    })
    .slice(0, 40);
}

function normalizeDietDay(value) {
  const day = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return DIET_PLAN_DAYS.includes(day) ? day : '';
}

function formatPlanDay(day) {
  return day.charAt(0).toUpperCase() + day.slice(1).toLowerCase();
}

function getLegacyDietCheatDays(input = {}) {
  if (Array.isArray(input.cheatDays) && input.cheatDays.length > 0) {
    return Array.from(
      new Set(
        input.cheatDays
          .map(normalizeDietDay)
          .filter(Boolean),
      ),
    ).slice(0, 6);
  }

  const preference =
    typeof input === 'string' ? input : input.flexibleMealPreference;
  const days = CHEAT_DAY_PREFERENCE_MAP[preference] || [];
  return [...days];
}

function getDietPlanDays(input = {}) {
  if (Array.isArray(input.planDays) && input.planDays.length > 0) {
    const planDaySet = new Set(
      input.planDays
        .map(normalizeDietDay)
        .filter(Boolean),
    );
    const planDays = DIET_PLAN_DAYS.filter(day => planDaySet.has(day)).slice(
      0,
      DIET_PLAN_DAYS.length,
    );

    if (planDays.length > 0) {
      return planDays;
    }
  }

  const cheatDaySet = new Set(getLegacyDietCheatDays(input));
  const planDays = DIET_PLAN_DAYS.filter(day => !cheatDaySet.has(day));

  return planDays.length > 0 ? planDays : [...DIET_PLAN_DAYS];
}

function normalizeRegenerationFeedback(feedback = {}, labels = {}) {
  const reason =
    typeof feedback.reason === 'string' ? feedback.reason.trim() : '';
  const note = typeof feedback.note === 'string' ? feedback.note.trim() : '';

  return {
    reason,
    note,
    reasonLabel: labels[reason] || '',
  };
}

function buildWorkoutRegenerationContext(surveyData, previousPlan) {
  const feedback = surveyData.regenerationFeedback;

  if (!feedback?.reason) {
    return '';
  }

  const previousExercises = Array.from(
    new Set((previousPlan?.items || []).map(item => item.name).filter(Boolean)),
  )
    .slice(0, 12)
    .join(', ');

  return `
Regeneration request:
- Main issue to fix: ${feedback.reasonLabel}
${feedback.note ? `- Additional user feedback: ${feedback.note}
` : ''}${previousPlan?.validation_note ? `- Admin note on previous plan: ${previousPlan.validation_note}
` : ''}${previousExercises ? `- Previous plan exercises to reduce or avoid repeating too closely: ${previousExercises}
` : ''}
Important regeneration rules:
- Produce a materially different weekly plan from the previous version while still matching the user's profile.
- Prioritize fixing the issue above.
- Avoid repeating the same exact combinations from the previous plan unless necessary.
`;
}

function buildDietRegenerationContext(surveyData, previousPlan) {
  const feedback = surveyData.regenerationFeedback;

  if (!feedback?.reason) {
    return '';
  }

  const previousMeals = Array.from(
    new Set((previousPlan?.items || []).map(item => item.title).filter(Boolean)),
  )
    .slice(0, 12)
    .join(', ');

  return `
Regeneration request:
- Main issue to fix: ${feedback.reasonLabel}
${feedback.note ? `- Additional user feedback: ${feedback.note}
` : ''}${previousPlan?.validation_note ? `- Admin note on previous plan: ${previousPlan.validation_note}
` : ''}${previousMeals ? `- Previous meals to reduce or avoid repeating too closely: ${previousMeals}
` : ''}
Important regeneration rules:
- Produce a materially different 7-day meal plan from the previous version while still matching the user's profile.
- Prioritize fixing the issue above.
- Avoid repeating the same exact meal pattern from the previous plan unless necessary.
`;
}

function buildPrompt(user, surveyData, exercises, previousPlan, activitySummary) {
  const {
    goal,
    fitnessLevel,
    trainingExperience,
    equipment,
    equipmentOther,
    days,
    duration,
    healthConditions,
    healthConditionsOther,
    medicationFactors,
    medicationFactorsOther,
    focusAreas,
    additionalNote,
  } = surveyData;

  const cleanEquipment = (equipment || []).filter(e => e !== 'None');
  const equipmentStr = cleanEquipment.length
    ? cleanEquipment.join(', ') + (equipmentOther ? `, ${equipmentOther}` : '')
    : 'body weight only';

  const cleanConditions = (healthConditions || []).filter(c => c !== 'None');
  const conditionsStr = cleanConditions.length
    ? cleanConditions.join(', ') + (healthConditionsOther ? `, ${healthConditionsOther}` : '')
    : 'none';

  const cleanMedicationFactors = (medicationFactors || []).filter(
    factor => factor !== 'No' && factor !== 'Prefer not to say',
  );
  const medicationStr = (medicationFactors || []).includes('Prefer not to say')
    ? 'not shared'
    : cleanMedicationFactors.length
    ? cleanMedicationFactors.join(', ') +
      (medicationFactorsOther ? `, ${medicationFactorsOther}` : '')
    : 'none reported';

  const cleanFocus = (focusAreas || []).filter(f => f !== 'Full body' && f !== 'Unsure');
  const focusStr = cleanFocus.length ? cleanFocus.join(', ').toLowerCase() : 'full body';
  const safetyProfile = buildWorkoutSafetyProfile({
    healthConditions,
    healthConditionsOther,
    medicationFactors,
    medicationFactorsOther,
  });
  const safetyGuidance = safetyProfile.promptNotes.join(' ');

  const DAYS_ORDER = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  const planDays = days && days.length
    ? DAYS_ORDER.filter(d => days.map(x => x.toLowerCase()).includes(d))
    : DAYS_ORDER.slice(0, 5);

  const exerciseData = exercises.map(e =>
    `id:${e.id} | ${e.name} | muscle:${e.muscle} | equipment:${e.equipment}`
  ).join('\n');

  const outputFormat = planDays.map(day =>
    `${day}:\n- exercise_id: <number>, sets: <number>, reps: <number> (use 0 for timed), duration_seconds: <number> (use 0 for rep-based)`
  ).join('\n');

  const regenerationContext = buildWorkoutRegenerationContext(
    surveyData,
    previousPlan,
  );

  return `You are given a list of exercises from a database. Only use the provided exercises.

User profile:
- Goal: ${goal || user.goal || 'general fitness'}
- Age: ${calcAge(user.dob) || 'unknown'}
- Height: ${user.height || 'unknown'} cm
- Weight: ${user.weight || 'unknown'} kg
- Gender: ${user.gender || 'unknown'}
- Fitness level: ${(fitnessLevel || 'Beginner').toLowerCase()}
- Prior training experience: ${trainingExperience || 'not specified'}
- Equipment: ${equipmentStr}
- Days: ${planDays.join(', ')}
- Duration per session: ${duration || '45 min'}
- Focus: ${focusStr}
- Health conditions: ${conditionsStr}
- Medication/substance factors affecting training: ${medicationStr}
${safetyGuidance ? `- Safety priorities: ${safetyGuidance}
` : ''}${additionalNote ? `- Additional note: ${additionalNote}
` : ''}${activitySummary ? `${activitySummary}
` : ''}

Exercise data:
${exerciseData}
${regenerationContext ? `
${regenerationContext}` : ''}

Task:
Create a weekly workout plan.

Rules:
- Use ONLY provided exercises (reference by exercise_id)
- Match ${(fitnessLevel || 'Beginner').toLowerCase()} difficulty
- Use current fitness level as the baseline difficulty, and use prior training experience only to adjust exercise familiarity, progression, and variety without exceeding that difficulty.
- Each day should contain 3-5 exercises
- The exercise pool already removes clear safety conflicts; still follow the safety priorities above when assigning volume and intensity.
- If medication/substance factors are present, keep the plan safety-first and avoid unnecessarily extreme intensity, volume, or conditioning demands.
- ${activitySummary ? 'Use the recent activity summary only as soft context for recovery, adherence, and progression; if synced days are limited, avoid over-correcting the plan based on it.' : 'Keep the plan realistic for the user\'s current recovery, adherence, and progression level.'}
- For timed exercises (planks, holds), set reps to 0 and duration to seconds (e.g. 30)
- For rep-based exercises, set duration to 0
- Do not repeat the same exercise too frequently

Output format STRICTLY (no extra text, no markdown):
${outputFormat}`;
}

function parseWorkoutResponse(raw, planDays) {
  const items = [];
  const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  let currentDay = null;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim().toLowerCase();
    const dayMatch = DAYS.find(d => trimmed.startsWith(d));
    if (dayMatch) { currentDay = dayMatch; continue; }
    if (!currentDay) continue;
    const match = line.match(/exercise_id:\s*(\d+),\s*sets:\s*(\d+),\s*reps:\s*(\d+),\s*duration_seconds:\s*(\d+)/);
    if (match) {
      const reps = parseInt(match[3]);
      const dur = parseInt(match[4]);
      items.push({
        exercise_id: parseInt(match[1]),
        day: currentDay.charAt(0).toUpperCase() + currentDay.slice(1),
        sets: parseInt(match[2]),
        reps: reps || null,
        duration: dur || null,
      });
    }
  }
  return items;
}

async function runWorkoutGeneration(userId, surveyData) {
  const user = await User.findById(userId);
  if (!user) {
    throw new Error('User not found');
  }

  const {
    fitnessLevel,
    equipment,
    equipmentOther,
    days,
    focusAreas,
    healthConditions,
    healthConditionsOther,
    medicationFactors,
    medicationFactorsOther,
  } = surveyData;
  const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const planDays = days && days.length
    ? days.map(d => d.toLowerCase())
    : DAYS.slice(0, 5).map(d => d.toLowerCase());

  const [previousPlan, allExercises, activitySummary] = await Promise.all([
    surveyData.previousPlanId
      ? WorkoutPlan.findById(surveyData.previousPlanId)
      : Promise.resolve(null),
    Exercise.find({}, 'id name muscle equipment difficulty'),
    getRecentWorkoutActivitySummary(userId),
  ]);
  const filtered = selectExercises(
    allExercises,
    {
      fitnessLevel,
      equipment,
      equipmentOther,
      focusAreas,
      planDays,
      healthConditions,
      healthConditionsOther,
      medicationFactors,
      medicationFactorsOther,
    },
    previousPlan,
  );

  if (filtered.length === 0) {
    throw new Error('No matching exercises found for your profile');
  }

  const prompt = buildPrompt(user, surveyData, filtered, previousPlan, activitySummary);
  console.log('Prompt preview:', prompt.slice(0, 300));

  let raw;
  try {
    raw = await askGemini(prompt);
    console.log('Gemini raw response:', raw?.slice(0, 500));
  } catch (geminiErr) {
    console.error('Gemini error:', geminiErr?.response?.data || geminiErr.message);
    throw new Error('AI generation failed');
  }

  const items = parseWorkoutResponse(raw, planDays);
  console.log('Parsed items:', items.length, items.slice(0, 3));
  if (items.length === 0) {
    throw new Error('Failed to parse AI response');
  }

  const validIds = new Set(filtered.map(e => e.id));
  const validItems = items.filter(i => validIds.has(i.exercise_id));

  const plan = await WorkoutPlan.create({
    user_id: userId,
    generated_by: 'ai',
    status: 'draft',
    survey_input: JSON.stringify(buildWorkoutSurveyInputForStorage(surveyData)),
    items: validItems,
  });

  await notifyAdminsAboutPlanValidation(user, plan, 'workout');

  return {plan};
}

function sendQueuedResponse(res, job, alreadyQueued, message) {
  return res.status(202).json({
    message,
    alreadyQueued,
    ...serializeJob(job),
  });
}

exports.generateWorkout = async (req, res) => {
  const surveyData = normalizeWorkoutSurveyData(req.body);
  const {job, alreadyQueued} = enqueueJob({
    userId: req.user.id,
    planType: 'workout',
    payload: surveyData,
    run: payload => runWorkoutGeneration(req.user.id, payload),
  });

  return sendQueuedResponse(
    res,
    job,
    alreadyQueued,
    alreadyQueued
      ? 'Your workout plan request is already in progress.'
      : 'Your workout plan request has been added to the AI queue.',
  );
};

exports.regenerateWorkout = async (req, res) => {
  try {
    const planId = Number(req.body.planId);
    const feedback = normalizeRegenerationFeedback(
      req.body.feedback || {},
      WORKOUT_REGEN_REASONS,
    );

    if (!planId) {
      return res.status(400).json({error: 'planId is required'});
    }

    if (!feedback.reason || !feedback.reasonLabel) {
      return res.status(400).json({error: 'A regenerate reason is required'});
    }

    const previousPlan = await WorkoutPlan.findById(planId);
    if (!previousPlan || previousPlan.user_id !== req.user.id) {
      return res.status(404).json({error: 'Workout plan not found'});
    }

    const surveyData = normalizeWorkoutSurveyData({
      ...(previousPlan.survey_input || {}),
      regenerationFeedback: feedback,
      previousPlanId: previousPlan.id,
    });

    const {job, alreadyQueued} = enqueueJob({
      userId: req.user.id,
      planType: 'workout',
      payload: surveyData,
      run: payload => runWorkoutGeneration(req.user.id, payload),
    });

    return sendQueuedResponse(
      res,
      job,
      alreadyQueued,
      alreadyQueued
        ? 'Your workout regeneration request is already in progress.'
        : 'Your workout regeneration request has been added to the AI queue.',
    );
  } catch (error) {
    return res.status(500).json({error: error.message});
  }
};

exports.getMyWorkout = async (req, res) => {
  try {
    const plans = await WorkoutPlan.find({ user_id: req.user.id });
    const aiPlans = plans
      .filter(plan => plan.generated_by === 'ai')
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    res.json(aiPlans);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

function filterRecipes(
  allRecipes,
  {dietType, allergies, allergiesOther, preferredCuisines, prepTime},
) {
  const allergySet = new Set(
    (allergies || [])
      .filter(a => a !== 'None' && a !== 'Other')
      .map(a => a.toLowerCase())
  );
  const customAllergyPatterns = buildCustomAllergyPatterns(allergiesOther);
  const cuisineSet = new Set(
    (preferredCuisines || []).map(value => String(value).toLowerCase()),
  );
  const useCuisineFilter = cuisineSet.size > 0 && !cuisineSet.has('any');
  const prepTimeLimit = getRecipePrepTimeLimit(prepTime);

  return allRecipes.filter(r => {
    const ingredientText = buildRecipeIngredientText(r);
    const readyInMinutes = Number(r.ready_in_minutes);

    if (dietType === 'Vegetarian' && !r.vegetarian) return false;
    if (dietType === 'Vegan' && !r.vegan) return false;
    if (dietType === 'Keto' && r.carbs > 10) return false;
    if (allergySet.has('gluten') && !r.gluten_free) return false;
    if (allergySet.has('dairy') && DIET_ALLERGY_INGREDIENT_PATTERNS.dairy.test(ingredientText)) return false;
    if (allergySet.has('nuts') && DIET_ALLERGY_INGREDIENT_PATTERNS.nuts.test(ingredientText)) return false;
    if (customAllergyPatterns.some(pattern => pattern.test(ingredientText))) return false;
    if (prepTimeLimit !== null && Number.isFinite(readyInMinutes) && readyInMinutes > prepTimeLimit) return false;
    if (useCuisineFilter && !cuisineSet.has((r.cuisine || '').toLowerCase())) return false;
    return true;
  });
}

function buildDietPrompt(user, surveyData, recipes, location, previousPlan, activityNote) {
  const {
    goal,
    dietType,
    allergies,
    allergiesOther,
    mealsPerDay,
    prepTime,
    availableIngredients,
    availableTools,
    flexibleMealPreference,
    flexibleMealDetails,
    additionalNote,
  } = surveyData;
  const allergyStr = (allergies || [])
    .filter(a => a !== 'None' && a !== 'Other')
    .concat(allergiesOther ? [allergiesOther] : [])
    .join(', ') || 'none';
  const mealsCount = parseInt(mealsPerDay) || 3;
  const age = calcAge(user.dob);
  const flexiblePreference = flexibleMealPreference || 'No flexibility';
  const plannedDays = getDietPlanDays(surveyData);
  const plannedDaySet = new Set(plannedDays);
  const planDayLabels = plannedDays.map(formatPlanDay);
  const skippedDayLabels = DIET_PLAN_DAYS
    .filter(day => !plannedDaySet.has(day))
    .map(formatPlanDay);
  const legacyFlexibilityLine =
    !Array.isArray(surveyData.planDays)
    && flexiblePreference !== 'No flexibility'
    && flexiblePreference !== 'No cheat days'
      ? `${flexiblePreference}${
          flexibleMealDetails ? ` (${flexibleMealDetails})` : ''
        }`
      : null;
  const preferredIngredients = Array.isArray(availableIngredients)
    ? availableIngredients.filter(Boolean)
    : [];
  const preferredTools = Array.isArray(availableTools)
    ? availableTools.filter(Boolean)
    : [];
  const hasPracticalPreferenceHints =
    preferredIngredients.length > 0 || preferredTools.length > 0;

  const MEAL_SETS = {
    2: ['breakfast', 'dinner'],
    3: ['breakfast', 'lunch', 'dinner'],
    4: ['breakfast', 'lunch', 'dinner', 'snack'],
    5: ['breakfast', 'morning_snack', 'lunch', 'afternoon_snack', 'dinner'],
  };
  const MEAL_TYPES = MEAL_SETS[mealsCount] || MEAL_SETS[3];

  const recipeData = recipes.map(r => {
    const ingredientSummary = hasPracticalPreferenceHints
      ? summarizeRecipeIngredients(r)
      : '';
    const toolSummary = hasPracticalPreferenceHints
      ? extractRecipeToolHints(r).join(', ')
      : '';

    return `id:${r.id} | kind:${r._usageKind || 'meal'} | ${r.title} | cal:${r.calories} | protein:${r.protein}g | carbs:${r.carbs}g | fat:${r.fat}g | prep:${r.ready_in_minutes}min${ingredientSummary ? ` | ingredients:${ingredientSummary}` : ''}${toolSummary ? ` | tools:${toolSummary}` : ''}`;
  }).join('\n');

  const outputFormat = plannedDays.map(day =>
    MEAL_TYPES.map(meal => `- day: ${day}, meal_type: ${meal}, recipe_id: <number>`).join('\n')
  ).join('\n');

  const regenerationContext = buildDietRegenerationContext(
    surveyData,
    previousPlan,
  );

  return `You are given a list of recipes from a database. Only use the provided recipes.

User profile:
- Goal: ${goal || user.goal || 'general health'}
- Age: ${age || 'unknown'}
- Gender: ${user.gender || 'unknown'}
- Height: ${user.height} cm, Weight: ${user.weight} kg
- Location: ${location?.city && location?.country ? `${location.city}, ${location.country}` : 'unknown'}
- Diet type: ${dietType || 'no preference'}
- Allergies: ${allergyStr}
- Meals per day: ${mealsCount}
- Prep time available: ${prepTime || 'no limit'}
- Available ingredients to prefer when practical: ${preferredIngredients.length ? preferredIngredients.join(', ') : 'not provided'}
- Available cooking tools to prefer when practical: ${preferredTools.length ? preferredTools.join(', ') : 'not provided'}
- Meal plan days: ${planDayLabels.join(', ')}
${legacyFlexibilityLine ? `- Flexibility preference: ${legacyFlexibilityLine}
` : ''}${skippedDayLabels.length ? `- Days without planned meals: ${skippedDayLabels.join(', ')}
` : ''}
${additionalNote ? `- Additional note: ${additionalNote}
` : ''}${activityNote ? `${activityNote}
` : ''}

Recipe data:
${recipeData}
${regenerationContext ? `
${regenerationContext}` : ''}

Task:
Create a weekly diet plan.

Rules:
- Use ONLY provided recipes (reference by recipe_id)
- Generate meals only for these days: ${planDayLabels.join(', ')}
- Do not generate any meals for days not listed above${skippedDayLabels.length ? ` (${skippedDayLabels.join(', ')})` : ''}
- Each planned day must have exactly ${mealsCount} meals: ${MEAL_TYPES.join(', ')}
- Vary recipes across days, avoid repeating the same recipe more than twice
- Respect the user's diet type and allergies
- If available ingredients or cooking tools are provided, treat them as soft preferences: prefer practical matches when possible, but do not narrow the plan unnecessarily or ignore better overall fits.
- Recipes marked kind:snack should only be assigned to snack, morning_snack, or afternoon_snack
- For breakfast, lunch, and dinner, prefer recipes marked kind:meal
- Omit all non-selected days entirely from the plan output.
- If legacy flexibility preferences are present, accommodate them while keeping the overall week aligned to the user's goal.
- For "Weekends more flexible", prefer placing the more flexible choices on Saturday and Sunday.
- For "1 flexible day per week" with no custom day specified, default to Saturday.
- Legacy flexibility handling must still use only the provided recipes and should not turn the whole week off-plan.
- Only assign solid food meals for breakfast, lunch, and dinner — drinks, smoothies, shakes, or juices should only be assigned as snacks if appropriate
- ${activityNote ? 'Use the recent activity note only as soft context for recovery and practicality. Do not aggressively change meal strictness or infer precise calorie needs from it.' : 'Keep the meal plan practical and sustainable for the user\'s likely recovery and adherence level.'}

Output format STRICTLY (no extra text, no markdown):
${outputFormat}`;
}

function parseDietResponse(raw, allowedDays = DIET_PLAN_DAYS) {
  const items = [];
  const allowedDaySet = new Set((allowedDays || []).map(day => day.toLowerCase()));

  for (const line of raw.split('\n')) {
    const match = line.match(/day:\s*(\w+),\s*meal_type:\s*([\w_]+),\s*recipe_id:\s*(\d+)/);
    if (match) {
      const day = match[1].toLowerCase();
      if (!allowedDaySet.has(day)) {
        continue;
      }

      items.push({
        day: formatPlanDay(day),
        meal_type: match[2].toLowerCase(),
        recipe_id: parseInt(match[3]),
      });
    }
  }
  return items;
}

async function runDietGeneration(userId, surveyData) {
  console.log('[Diet] generateDiet called, user:', userId, 'body:', JSON.stringify(surveyData));
  const user = await User.findById(userId);
  if (!user) {
    throw new Error('User not found');
  }

  const {
    goal,
    dietType,
    allergies,
    allergiesOther,
    preferredCuisines,
    prepTime,
    availableIngredients,
    availableTools,
    latitude,
    longitude,
  } = surveyData;
  const location = surveyData.location
    ? surveyData.location
    : (latitude && longitude)
    ? await reverseGeocode(latitude, longitude)
    : {city: null, country: null};
  console.log('[Diet] location:', location);

  const [previousPlan, activityNote] = await Promise.all([
    surveyData.previousPlanId
      ? DietPlan.findById(surveyData.previousPlanId)
      : Promise.resolve(null),
    getRecentDietActivityNote(userId),
  ]);
  const plannedDays = getDietPlanDays(surveyData);
  const plannedDaySet = new Set(plannedDays.map(formatPlanDay));

  const Recipe = require('../recipe/recipe.model');
  const allRecipes = await Recipe.findAll();
  const filtered = selectRecipes(allRecipes, {
    goal: goal || user.goal,
    dietType,
    allergies,
    allergiesOther,
    preferredCuisines,
    prepTime,
    availableIngredients,
    availableTools,
  });
  if (filtered.length === 0) {
    throw new Error('No matching recipes found for your profile');
  }

  const prompt = buildDietPrompt(
    user,
    surveyData,
    filtered,
    location,
    previousPlan,
    activityNote,
  );
  console.log('[Diet] Input surveyData:', JSON.stringify(surveyData, null, 2));
  console.log('[Diet] Prompt preview:', prompt.slice(0, 300));

  let raw;
  try {
    raw = await askGemini(prompt);
    console.log('[Diet] Gemini raw response:', raw?.slice(0, 500));
  } catch (geminiErr) {
    console.error('[Diet] Gemini error:', geminiErr?.response?.data || geminiErr.message);
    throw new Error('AI generation failed');
  }

  const items = parseDietResponse(raw, plannedDays);
  console.log('[Diet] Parsed items:', items.length, items.slice(0, 3));
  if (items.length === 0) {
    throw new Error('Failed to parse AI response');
  }

  const validIds = new Set(filtered.map(r => r.id));
  const recipeUsageById = new Map(
    filtered.map(r => [r.id, r._usageKind || 'meal']),
  );
  const validItems = items.filter(
    i => validIds.has(i.recipe_id)
      && plannedDaySet.has(i.day)
      && (
        recipeUsageById.get(i.recipe_id) !== 'snack'
        || isSnackMealType(i.meal_type)
      ),
  );

  if (validItems.length === 0) {
    throw new Error('Failed to generate a valid diet plan');
  }

  const plan = await DietPlan.create({
    user_id: userId,
    status: 'draft',
    survey_input: JSON.stringify(
      buildDietSurveyInputForStorage(surveyData, location),
    ),
    items: validItems,
  });

  await notifyAdminsAboutPlanValidation(user, plan, 'diet');

  return {plan};
}

exports.generateDiet = async (req, res) => {
  const surveyData = normalizeDietSurveyData(req.body);
  const {job, alreadyQueued} = enqueueJob({
    userId: req.user.id,
    planType: 'diet',
    payload: surveyData,
    run: payload => runDietGeneration(req.user.id, payload),
  });

  return sendQueuedResponse(
    res,
    job,
    alreadyQueued,
    alreadyQueued
      ? 'Your diet plan request is already in progress.'
      : 'Your diet plan request has been added to the AI queue.',
  );
};

exports.regenerateDiet = async (req, res) => {
  try {
    const planId = Number(req.body.planId);
    const feedback = normalizeRegenerationFeedback(
      req.body.feedback || {},
      DIET_REGEN_REASONS,
    );

    if (!planId) {
      return res.status(400).json({error: 'planId is required'});
    }

    if (!feedback.reason || !feedback.reasonLabel) {
      return res.status(400).json({error: 'A regenerate reason is required'});
    }

    const previousPlan = await DietPlan.findById(planId);
    if (!previousPlan || previousPlan.user_id !== req.user.id) {
      return res.status(404).json({error: 'Diet plan not found'});
    }

    const surveyData = normalizeDietSurveyData({
      ...(previousPlan.survey_input || {}),
      regenerationFeedback: feedback,
      previousPlanId: previousPlan.id,
    });

    const {job, alreadyQueued} = enqueueJob({
      userId: req.user.id,
      planType: 'diet',
      payload: surveyData,
      run: payload => runDietGeneration(req.user.id, payload),
    });

    return sendQueuedResponse(
      res,
      job,
      alreadyQueued,
      alreadyQueued
        ? 'Your diet regeneration request is already in progress.'
        : 'Your diet regeneration request has been added to the AI queue.',
    );
  } catch (error) {
    return res.status(500).json({error: error.message});
  }
};

exports.getGenerationStatus = async (req, res) => {
  const job = getJob(req.params.jobId);

  if (!job || job.userId !== req.user.id) {
    return res.status(404).json({error: 'Generation job not found'});
  }

  return res.json(serializeJob(job));
};

exports.getMyDiet = async (req, res) => {
  try {
    const plans = await DietPlan.find({ user_id: req.user.id });
    plans.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    res.json(plans);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
