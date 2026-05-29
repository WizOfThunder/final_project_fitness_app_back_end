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
const {enqueueJob, getJob, serializeJob} = require('./aiQueue');

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

const MAX_WORKOUT_PROMPT_EXERCISES = 50;
const MAX_DIET_PROMPT_RECIPES = 40;
const MAX_PROMPT_TEXT_LENGTH = 120;
const MAX_RECIPE_PROMPT_INGREDIENTS = 6;
const MAX_RECIPE_PROMPT_TAGS = 5;
const DEFAULT_DIET_ACTIVITY_MULTIPLIER = 1.45;
const MAX_WORKOUT_GENERATION_ATTEMPTS = 2;

const WORKOUT_DAY_ORDER = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
];

const WORKOUT_DURATION_MINUTES = {
  '15 min': 15,
  '30 min': 30,
  '45 min': 45,
  '60 min': 60,
};

const WORKOUT_PUSH_MUSCLES = new Set(['chest', 'shoulders', 'triceps']);
const WORKOUT_PULL_MUSCLES = new Set([
  'lats',
  'middle_back',
  'biceps',
  'traps',
  'forearms',
  'neck',
]);
const WORKOUT_LOWER_MUSCLES = new Set([
  'quadriceps',
  'hamstrings',
  'glutes',
  'calves',
  'adductors',
  'abductors',
]);
const WORKOUT_CORE_MUSCLES = new Set(['abdominals', 'lower_back']);

const WORKOUT_MOBILITY_KEYWORDS = [
  'stretch',
  'mobility',
  'foam roll',
  'yoga',
  'cat cow',
  'child pose',
  'thoracic rotation',
  'worlds greatest stretch',
];

const WORKOUT_CARDIO_KEYWORDS = [
  'run',
  'bike',
  'cycle',
  'rowing',
  'rower',
  'jump rope',
  'burpee',
  'mountain climber',
  'high knees',
  'sprint',
  'skater',
  'cardio',
];

const WORKOUT_PUSH_KEYWORDS = [
  'press',
  'push-up',
  'push up',
  'dip',
  'fly',
  'chest press',
  'shoulder press',
  'bench',
  'tricep',
  'lateral raise',
  'front raise',
];

const WORKOUT_PULL_KEYWORDS = [
  'row',
  'pull-up',
  'pull up',
  'pulldown',
  'lat',
  'face pull',
  'rear delt',
  'shrug',
  'curl',
  'hammer curl',
];

const WORKOUT_LOWER_KEYWORDS = [
  'squat',
  'lunge',
  'deadlift',
  'hinge',
  'leg press',
  'leg curl',
  'leg extension',
  'hip thrust',
  'glute',
  'hamstring',
  'quad',
  'calf',
  'step-up',
  'step up',
  'split squat',
  'bulgarian',
];

const WORKOUT_CORE_KEYWORDS = [
  'plank',
  'crunch',
  'sit-up',
  'sit up',
  'russian twist',
  'hollow',
  'dead bug',
  'bird dog',
  'woodchop',
  'core',
  'ab',
  'oblique',
];

const WORKOUT_HIGH_IMPACT_KEYWORDS = [
  'jump',
  'burpee',
  'box',
  'hop',
  'bounds',
  'high knees',
  'jump rope',
  'skater',
  'sprint',
  'plyo',
];

const WORKOUT_SPINAL_LOAD_KEYWORDS = [
  'deadlift',
  'good morning',
  'bent-over',
  'bent over',
  'barbell row',
  'back squat',
  'front squat',
  'overhead press',
  'military press',
  'clean',
  'snatch',
  'thruster',
];

const WORKOUT_KNEE_STRESS_KEYWORDS = [
  'jump',
  'lunge',
  'split squat',
  'bulgarian',
  'pistol',
  'step-up',
  'step up',
  'skater',
  'sissy squat',
  'leg extension',
];

const WORKOUT_BALLISTIC_KEYWORDS = [
  'clean',
  'snatch',
  'jerk',
  'swing',
  'push press',
  'thruster',
  'plyo',
  'jump',
];

const WORKOUT_INTENSE_CARDIO_KEYWORDS = [
  'sprint',
  'burpee',
  'jump rope',
  'mountain climber',
  'high knees',
  'tabata',
  'hiit',
  'skater',
];

const WORKOUT_COMPOUND_KEYWORDS = [
  'squat',
  'deadlift',
  'row',
  'press',
  'pull-up',
  'pull up',
  'lunge',
  'dip',
  'hip thrust',
];

const WORKOUT_ISOLATION_KEYWORDS = [
  'curl',
  'extension',
  'raise',
  'kickback',
  'fly',
  'adduction',
  'abduction',
  'calf raise',
  'crunch',
];

const PREP_TIME_LIMITS = {
  '10 - 30 minutes': 30,
  '30 minutes - 1 hour': 60,
  '1 hour to 2 hours': 120,
  'No time limit': Infinity,
};

const DAIRY_INGREDIENT_KEYWORDS = [
  'milk',
  'cheese',
  'butter',
  'yogurt',
  'ghee',
  'whey',
  'casein',
  'cream cheese',
  'heavy cream',
  'sour cream',
  'half and half',
];

const NUT_INGREDIENT_KEYWORDS = [
  'almond',
  'cashew',
  'walnut',
  'pecan',
  'pistachio',
  'hazelnut',
  'macadamia',
  'peanut',
  'nut',
];

const GLUTEN_INGREDIENT_KEYWORDS = [
  'wheat',
  'flour',
  'bread',
  'breadcrumbs',
  'barley',
  'rye',
  'seitan',
  'soy sauce',
  'pasta',
  'noodle',
  'cracker',
];

function normalizeGoal(value) {
  const goal = String(value || '').trim().toLowerCase();

  if (goal.includes('weight')) return 'weight_loss';
  if (goal.includes('muscle')) return 'muscle_gain';
  if (goal.includes('endur')) return 'improve_endurance';
  if (goal.includes('recover')) return 'recovery';
  if (goal.includes('maint')) return 'maintenance';
  if (goal.includes('health')) return 'eat_healthier';
  if (goal.includes('active')) return 'stay_active';

  return 'general';
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeTextLower(value) {
  return normalizeText(value).toLowerCase();
}

function toFiniteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function truncateText(value, maxLength = MAX_PROMPT_TEXT_LENGTH) {
  const text = normalizeText(value).replace(/\s+/g, ' ');
  if (!text) return '';
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3)}...`;
}

function getAllowedMuscles(focusAreas = []) {
  const cleanFocus = (focusAreas || []).filter(
    focus => focus !== 'Full body' && focus !== 'Unsure',
  );

  if (!cleanFocus.length) {
    return null;
  }

  const allowedMuscles = new Set();
  for (const area of cleanFocus) {
    const muscles = FOCUS_MUSCLE_MAP[area];
    if (muscles) {
      muscles.forEach(muscle => allowedMuscles.add(muscle));
    }
  }

  return allowedMuscles.size ? allowedMuscles : null;
}

function getSelectedEquipmentTokens(equipment = [], equipmentOther = '') {
  const cleanEquipment = (equipment || []).filter(item => item !== 'None');
  const hasGym = cleanEquipment.includes('Full gym');
  const tokens = new Set();

  if (!cleanEquipment.length) {
    tokens.add('body only');
    tokens.add('bodyweight');
  }
  if (cleanEquipment.includes('Dumbbells')) tokens.add('dumbbell');
  if (cleanEquipment.includes('Resistance bands')) tokens.add('band');
  if (hasGym) {
    [
      'barbell',
      'cable',
      'machine',
      'ez curl',
      'e-z curl',
      'kettlebell',
      'medicine ball',
      'exercise ball',
      'foam roll',
      'bench',
      'rack',
      'pull-up',
      'dip',
      'smith',
      'sled',
    ].forEach(token => tokens.add(token));
  }

  const customEquipment = normalizeTextLower(equipmentOther);
  if (customEquipment) {
    tokens.add(customEquipment);
  }

  tokens.add('');
  return tokens;
}

function getWorkoutPlanDays(input = {}) {
  if (Array.isArray(input.days) && input.days.length > 0) {
    const planDaySet = new Set(
      input.days.map(normalizeTextLower).filter(day => WORKOUT_DAY_ORDER.includes(day)),
    );
    const planDays = WORKOUT_DAY_ORDER.filter(day => planDaySet.has(day));

    if (planDays.length > 0) {
      return planDays;
    }
  }

  return WORKOUT_DAY_ORDER.slice(0, 5);
}

function getWorkoutDurationMinutes(duration) {
  return WORKOUT_DURATION_MINUTES[duration] || 45;
}

function textIncludesAny(text, keywords = []) {
  return keywords.some(keyword => text.includes(keyword));
}

function buildExerciseSearchText(exercise = {}) {
  return [
    exercise.name,
    exercise.type,
    exercise.muscle,
    exercise.equipment,
    exercise.instructions,
    exercise.safety_info,
  ]
    .map(normalizeTextLower)
    .filter(Boolean)
    .join(' ');
}

function getExerciseProfile(exercise = {}) {
  const text = buildExerciseSearchText(exercise);
  const muscle = normalizeTextLower(exercise.muscle);
  const mobility =
    normalizeTextLower(exercise.type).includes('stretch')
    || normalizeTextLower(exercise.type).includes('mobility')
    || textIncludesAny(text, WORKOUT_MOBILITY_KEYWORDS);
  const cardio =
    normalizeTextLower(exercise.type).includes('cardio')
    || textIncludesAny(text, WORKOUT_CARDIO_KEYWORDS);

  let pattern = 'accessory';
  if (mobility) {
    pattern = 'mobility';
  } else if (cardio) {
    pattern = 'cardio';
  } else if (
    textIncludesAny(text, WORKOUT_LOWER_KEYWORDS)
    || WORKOUT_LOWER_MUSCLES.has(muscle)
  ) {
    pattern = 'lower';
  } else if (
    textIncludesAny(text, WORKOUT_PUSH_KEYWORDS)
    || WORKOUT_PUSH_MUSCLES.has(muscle)
  ) {
    pattern = 'push';
  } else if (
    textIncludesAny(text, WORKOUT_PULL_KEYWORDS)
    || WORKOUT_PULL_MUSCLES.has(muscle)
  ) {
    pattern = 'pull';
  } else if (
    textIncludesAny(text, WORKOUT_CORE_KEYWORDS)
    || WORKOUT_CORE_MUSCLES.has(muscle)
  ) {
    pattern = 'core';
  }

  const riskFlags = new Set();
  if (textIncludesAny(text, WORKOUT_HIGH_IMPACT_KEYWORDS)) {
    riskFlags.add('high_impact');
  }
  if (textIncludesAny(text, WORKOUT_SPINAL_LOAD_KEYWORDS)) {
    riskFlags.add('spinal_load');
  }
  if (textIncludesAny(text, WORKOUT_KNEE_STRESS_KEYWORDS)) {
    riskFlags.add('knee_stress');
  }
  if (textIncludesAny(text, WORKOUT_BALLISTIC_KEYWORDS)) {
    riskFlags.add('ballistic');
  }
  if (
    textIncludesAny(text, WORKOUT_INTENSE_CARDIO_KEYWORDS)
    || (cardio && riskFlags.has('high_impact'))
  ) {
    riskFlags.add('intense_cardio');
  }

  const isCompound =
    ['push', 'pull', 'lower'].includes(pattern)
    && (
      textIncludesAny(text, WORKOUT_COMPOUND_KEYWORDS)
      || !textIncludesAny(text, WORKOUT_ISOLATION_KEYWORDS)
    );

  return {
    pattern,
    riskFlags,
    isCompound,
  };
}

function buildWorkoutSafetyContext(surveyData = {}) {
  const conditions = new Set(
    (surveyData.healthConditions || [])
      .map(normalizeTextLower)
      .filter(value => value && value !== 'none'),
  );
  const medicationFactors = new Set(
    (surveyData.medicationFactors || [])
      .map(normalizeTextLower)
      .filter(value => value && value !== 'no' && value !== 'prefer not to say'),
  );
  const goalKey = normalizeGoal(surveyData.goal);

  return {
    conditions,
    medicationFactors,
    goalKey,
    avoidHighImpact:
      conditions.has('back pain')
      || conditions.has('knee issues')
      || medicationFactors.has('stimulant medication')
      || medicationFactors.has('blood pressure / heart medication')
      || goalKey === 'recovery',
    avoidSpinalLoad: conditions.has('back pain'),
    avoidKneeStress: conditions.has('knee issues'),
    avoidIntenseConditioning:
      medicationFactors.has('stimulant medication')
      || medicationFactors.has('blood pressure / heart medication')
      || goalKey === 'recovery',
    avoidBallistic:
      conditions.has('back pain')
      || conditions.has('knee issues')
      || goalKey === 'recovery',
  };
}

function hasWorkoutSafetyRestrictions(safetyContext) {
  return (
    safetyContext.avoidHighImpact
    || safetyContext.avoidSpinalLoad
    || safetyContext.avoidKneeStress
    || safetyContext.avoidIntenseConditioning
    || safetyContext.avoidBallistic
  );
}

function violatesWorkoutSafety(profile, safetyContext, mode = 'strict') {
  if (safetyContext.avoidHighImpact && profile.riskFlags.has('high_impact')) {
    return true;
  }
  if (safetyContext.avoidSpinalLoad && profile.riskFlags.has('spinal_load')) {
    return true;
  }
  if (safetyContext.avoidIntenseConditioning && profile.riskFlags.has('intense_cardio')) {
    return true;
  }
  if (mode === 'strict') {
    if (safetyContext.avoidKneeStress && profile.riskFlags.has('knee_stress')) {
      return true;
    }
    if (safetyContext.avoidBallistic && profile.riskFlags.has('ballistic')) {
      return true;
    }
  }

  return false;
}

function applyWorkoutSafetyFilters(exercises, surveyData) {
  const safetyContext = buildWorkoutSafetyContext(surveyData);
  if (!hasWorkoutSafetyRestrictions(safetyContext)) {
    return exercises;
  }

  const minimumUsefulCount = Math.max(
    12,
    getWorkoutPlanDays(surveyData).length * 4,
  );
  const strict = exercises.filter(
    exercise => !violatesWorkoutSafety(getExerciseProfile(exercise), safetyContext),
  );
  if (strict.length >= Math.min(exercises.length, minimumUsefulCount)) {
    return strict;
  }

  const relaxed = exercises.filter(
    exercise =>
      !violatesWorkoutSafety(getExerciseProfile(exercise), safetyContext, 'relaxed'),
  );

  return relaxed.length ? relaxed : strict;
}

function hasWorkoutHealthOrMedicationConstraints(surveyData = {}) {
  const hasHealthConditions = (surveyData.healthConditions || []).some(
    value => normalizeTextLower(value) && normalizeTextLower(value) !== 'none',
  );
  const hasMedicationFactors = (surveyData.medicationFactors || []).some(
    value => {
      const normalized = normalizeTextLower(value);
      return normalized && normalized !== 'no' && normalized !== 'prefer not to say';
    },
  );

  return hasHealthConditions || hasMedicationFactors;
}

function getWorkoutSessionBudget(duration, label = '') {
  const targetMinutes = getWorkoutDurationMinutes(duration);
  let minExercises = 4;
  let maxExercises = 5;

  if (targetMinutes <= 15) {
    minExercises = 3;
    maxExercises = 3;
  } else if (targetMinutes <= 30) {
    minExercises = 3;
    maxExercises = 4;
  }

  if (label.toLowerCase().includes('recovery')) {
    minExercises = Math.min(minExercises, 3);
    maxExercises = Math.min(maxExercises, 4);
  }

  return {
    targetMinutes,
    minExercises,
    maxExercises,
    minMinutes:
      targetMinutes <= 15
        ? 8
        : targetMinutes <= 30
        ? 16
        : Math.max(22, targetMinutes - 12),
    maxMinutes: targetMinutes + (targetMinutes <= 30 ? 8 : 12),
  };
}

function buildWorkoutDaySpec(day, label, config, surveyData) {
  const focusAreas = surveyData.focusAreas || [];
  const goalKey = normalizeGoal(surveyData.goal);
  const budget = getWorkoutSessionBudget(surveyData.duration, label);
  const notes = [];

  if (
    focusAreas.includes('Core')
    && !config.minPatternCounts?.core
    && !label.toLowerCase().includes('core')
  ) {
    notes.push('add one core finisher if time allows');
  }
  if (
    focusAreas.includes('Upper body')
    && ['upper', 'push', 'pull', 'full body'].some(token =>
      label.toLowerCase().includes(token),
    )
  ) {
    notes.push('slightly bias effort toward upper-body emphasis');
  }
  if (
    focusAreas.includes('Lower body')
    && label.toLowerCase().includes('lower')
  ) {
    notes.push('slightly bias effort toward lower-body emphasis');
  }
  if (goalKey === 'recovery') {
    notes.push('keep tempo controlled and low impact');
  }

  return {
    day,
    label,
    minPatternCounts: config.minPatternCounts || {},
    requiredAnyPatternGroups: config.requiredAnyPatternGroups || [],
    preferredPatternCounts: config.preferredPatternCounts || {},
    maxPatternCounts: config.maxPatternCounts || {},
    minDistinctPatterns: config.minDistinctPatterns || 1,
    notes,
    ...budget,
  };
}

function buildWorkoutSplitPlan(planDays, surveyData) {
  const dayCount = planDays.length;
  const goalKey = normalizeGoal(surveyData.goal);
  const templates = [];

  if (dayCount <= 1) {
    templates.push({
      label: 'Full Body',
      minPatternCounts: {lower: 1},
      requiredAnyPatternGroups: [['push', 'pull']],
      preferredPatternCounts: {core: 1},
      maxPatternCounts: {lower: 2, push: 2, pull: 2, core: 2, cardio: 1},
      minDistinctPatterns: 2,
    });
  } else if (dayCount === 2) {
    templates.push(
      {
        label: 'Upper',
        minPatternCounts: {push: 1, pull: 1},
        preferredPatternCounts: {core: 1},
        maxPatternCounts: {push: 3, pull: 3, lower: 1, core: 2},
        minDistinctPatterns: 2,
      },
      {
        label: 'Lower + Core',
        minPatternCounts: {lower: 2},
        preferredPatternCounts: {core: 1},
        maxPatternCounts: {lower: 3, core: 2, push: 1, pull: 1},
        minDistinctPatterns: 2,
      },
    );
  } else if (dayCount === 3) {
    if (goalKey === 'muscle_gain') {
      templates.push(
        {
          label: 'Push',
          minPatternCounts: {push: 2},
          preferredPatternCounts: {core: 1},
          requiredAnyPatternGroups: [['pull', 'core']],
          maxPatternCounts: {push: 3, pull: 1, core: 2, lower: 1},
          minDistinctPatterns: 2,
        },
        {
          label: 'Legs + Core',
          minPatternCounts: {lower: 2},
          preferredPatternCounts: {core: 1},
          maxPatternCounts: {lower: 3, core: 2, push: 1, pull: 1},
          minDistinctPatterns: 2,
        },
        {
          label: 'Pull',
          minPatternCounts: {pull: 2},
          preferredPatternCounts: {core: 1},
          requiredAnyPatternGroups: [['push', 'core']],
          maxPatternCounts: {pull: 3, push: 1, core: 2, lower: 1},
          minDistinctPatterns: 2,
        },
      );
    } else {
      templates.push(
        {
          label: 'Full Body',
          minPatternCounts: {lower: 1},
          requiredAnyPatternGroups: [['push', 'pull']],
          preferredPatternCounts: {core: 1},
          maxPatternCounts: {lower: 2, push: 2, pull: 2, core: 2},
          minDistinctPatterns: 3,
        },
        {
          label: 'Lower + Core',
          minPatternCounts: {lower: 2},
          preferredPatternCounts: {core: 1},
          maxPatternCounts: {lower: 3, core: 2, push: 1, pull: 1},
          minDistinctPatterns: 2,
        },
        {
          label: 'Upper',
          minPatternCounts: {push: 1, pull: 1},
          preferredPatternCounts: {core: 1},
          maxPatternCounts: {push: 3, pull: 3, lower: 1, core: 2},
          minDistinctPatterns: 2,
        },
      );
    }
  } else if (dayCount === 4) {
    templates.push(
      {
        label: 'Upper',
        minPatternCounts: {push: 1, pull: 1},
        preferredPatternCounts: {core: 1},
        maxPatternCounts: {push: 3, pull: 3, lower: 1, core: 2},
        minDistinctPatterns: 2,
      },
      {
        label: 'Lower + Core',
        minPatternCounts: {lower: 2},
        preferredPatternCounts: {core: 1},
        maxPatternCounts: {lower: 3, core: 2, push: 1, pull: 1},
        minDistinctPatterns: 2,
      },
      {
        label: 'Upper',
        minPatternCounts: {push: 1, pull: 1},
        preferredPatternCounts: {core: 1},
        maxPatternCounts: {push: 3, pull: 3, lower: 1, core: 2},
        minDistinctPatterns: 2,
      },
      {
        label: 'Lower + Core',
        minPatternCounts: {lower: 2},
        preferredPatternCounts: {core: 1},
        maxPatternCounts: {lower: 3, core: 2, push: 1, pull: 1},
        minDistinctPatterns: 2,
      },
    );
  } else if (dayCount === 5) {
    templates.push(
      {
        label: 'Push',
        minPatternCounts: {push: 2},
        preferredPatternCounts: {core: 1},
        requiredAnyPatternGroups: [['pull', 'core']],
        maxPatternCounts: {push: 3, pull: 1, core: 2, lower: 1},
        minDistinctPatterns: 2,
      },
      {
        label: 'Pull',
        minPatternCounts: {pull: 2},
        preferredPatternCounts: {core: 1},
        requiredAnyPatternGroups: [['push', 'core']],
        maxPatternCounts: {pull: 3, push: 1, core: 2, lower: 1},
        minDistinctPatterns: 2,
      },
      {
        label: 'Legs + Core',
        minPatternCounts: {lower: 2},
        preferredPatternCounts: {core: 1},
        maxPatternCounts: {lower: 3, core: 2, push: 1, pull: 1},
        minDistinctPatterns: 2,
      },
      {
        label: 'Upper',
        minPatternCounts: {push: 1, pull: 1},
        preferredPatternCounts: {core: 1},
        maxPatternCounts: {push: 3, pull: 3, lower: 1, core: 2},
        minDistinctPatterns: 2,
      },
      {
        label: 'Lower + Core',
        minPatternCounts: {lower: 2},
        preferredPatternCounts: {core: 1},
        maxPatternCounts: {lower: 3, core: 2, push: 1, pull: 1},
        minDistinctPatterns: 2,
      },
    );
  } else if (dayCount === 6) {
    templates.push(
      {
        label: 'Push',
        minPatternCounts: {push: 2},
        preferredPatternCounts: {core: 1},
        requiredAnyPatternGroups: [['pull', 'core']],
        maxPatternCounts: {push: 3, pull: 1, core: 2, lower: 1},
        minDistinctPatterns: 2,
      },
      {
        label: 'Pull',
        minPatternCounts: {pull: 2},
        preferredPatternCounts: {core: 1},
        requiredAnyPatternGroups: [['push', 'core']],
        maxPatternCounts: {pull: 3, push: 1, core: 2, lower: 1},
        minDistinctPatterns: 2,
      },
      {
        label: 'Legs + Core',
        minPatternCounts: {lower: 2},
        preferredPatternCounts: {core: 1},
        maxPatternCounts: {lower: 3, core: 2, push: 1, pull: 1},
        minDistinctPatterns: 2,
      },
      {
        label: 'Push',
        minPatternCounts: {push: 2},
        preferredPatternCounts: {core: 1},
        requiredAnyPatternGroups: [['pull', 'core']],
        maxPatternCounts: {push: 3, pull: 1, core: 2, lower: 1},
        minDistinctPatterns: 2,
      },
      {
        label: 'Pull',
        minPatternCounts: {pull: 2},
        preferredPatternCounts: {core: 1},
        requiredAnyPatternGroups: [['push', 'core']],
        maxPatternCounts: {pull: 3, push: 1, core: 2, lower: 1},
        minDistinctPatterns: 2,
      },
      {
        label: 'Legs + Core',
        minPatternCounts: {lower: 2},
        preferredPatternCounts: {core: 1},
        maxPatternCounts: {lower: 3, core: 2, push: 1, pull: 1},
        minDistinctPatterns: 2,
      },
    );
  } else {
    templates.push(
      {
        label: 'Push',
        minPatternCounts: {push: 2},
        preferredPatternCounts: {core: 1},
        requiredAnyPatternGroups: [['pull', 'core']],
        maxPatternCounts: {push: 3, pull: 1, core: 2, lower: 1},
        minDistinctPatterns: 2,
      },
      {
        label: 'Pull',
        minPatternCounts: {pull: 2},
        preferredPatternCounts: {core: 1},
        requiredAnyPatternGroups: [['push', 'core']],
        maxPatternCounts: {pull: 3, push: 1, core: 2, lower: 1},
        minDistinctPatterns: 2,
      },
      {
        label: 'Legs + Core',
        minPatternCounts: {lower: 2},
        preferredPatternCounts: {core: 1},
        maxPatternCounts: {lower: 3, core: 2, push: 1, pull: 1},
        minDistinctPatterns: 2,
      },
      {
        label: 'Upper',
        minPatternCounts: {push: 1, pull: 1},
        preferredPatternCounts: {core: 1},
        maxPatternCounts: {push: 3, pull: 3, lower: 1, core: 2},
        minDistinctPatterns: 2,
      },
      {
        label: 'Lower + Core',
        minPatternCounts: {lower: 2},
        preferredPatternCounts: {core: 1},
        maxPatternCounts: {lower: 3, core: 2, push: 1, pull: 1},
        minDistinctPatterns: 2,
      },
      {
        label: 'Full Body',
        minPatternCounts: {lower: 1},
        requiredAnyPatternGroups: [['push', 'pull']],
        preferredPatternCounts: {core: 1},
        maxPatternCounts: {lower: 2, push: 2, pull: 2, core: 2},
        minDistinctPatterns: 3,
      },
      {
        label: 'Recovery + Core',
        minPatternCounts: {core: 1},
        requiredAnyPatternGroups: [['mobility', 'cardio', 'push', 'pull', 'lower']],
        preferredPatternCounts: {mobility: 1},
        maxPatternCounts: {core: 2, mobility: 2, cardio: 2, push: 1, pull: 1, lower: 1},
        minDistinctPatterns: 2,
      },
    );
  }

  return planDays.map((day, index) =>
    buildWorkoutDaySpec(day, templates[index].label, templates[index], surveyData),
  );
}

function formatWorkoutSplitPlan(splitPlan) {
  return splitPlan.map(spec => {
    const hardRequirements = Object.entries(spec.minPatternCounts)
      .map(([pattern, count]) => `${count}+ ${pattern}`)
      .join(', ');
    const anyRequirements = spec.requiredAnyPatternGroups
      .map(group => `include at least 1 of ${group.join(' / ')}`)
      .join('; ');
    const requiredText = [hardRequirements || 'balanced mix', anyRequirements]
      .filter(Boolean)
      .join('; ');

    return `- ${formatPlanDay(spec.day)}: ${spec.label} | ${spec.minExercises}-${spec.maxExercises} exercises | target ${spec.targetMinutes} min | required: ${requiredText}`;
  }).join('\n');
}

function estimateWorkoutItemMinutes(item, exercise, fitnessLevel) {
  const profile = getExerciseProfile(exercise);
  const sets = Math.max(parseInt(item.sets, 10) || 1, 1);
  const reps = Math.max(parseInt(item.reps, 10) || 0, 0);
  const durationSeconds = Math.max(parseInt(item.duration, 10) || 0, 0);
  const activeMinutes = durationSeconds > 0
    ? (sets * durationSeconds) / 60
    : (sets * Math.max(reps, 8) * (profile.pattern === 'mobility' ? 4 : 3)) / 60;

  let restSeconds = 45;
  if (profile.pattern === 'mobility') restSeconds = 20;
  else if (profile.pattern === 'core') restSeconds = 30;
  else if (profile.pattern === 'cardio') restSeconds = 25;
  else if (profile.isCompound) {
    restSeconds = normalizeTextLower(fitnessLevel) === 'advanced' ? 75 : 60;
  } else if (normalizeTextLower(fitnessLevel) === 'advanced') {
    restSeconds = 55;
  }

  const setupMinutes = 0.4 * sets;
  const restMinutes = (Math.max(sets - 1, 0) * restSeconds) / 60;
  return activeMinutes + setupMinutes + restMinutes;
}

function validateWorkoutPlan(items, exercisesById, splitPlan, surveyData) {
  const errors = [];
  const grouped = new Map();
  const dayOrder = splitPlan.map(spec => spec.day);
  const selectedDaySet = new Set(dayOrder);
  const exerciseUsage = new Map();

  for (const item of items) {
    const dayKey = normalizeTextLower(item.day);
    if (!selectedDaySet.has(dayKey)) {
      continue;
    }
    if (!grouped.has(dayKey)) {
      grouped.set(dayKey, []);
    }
    grouped.get(dayKey).push(item);
    exerciseUsage.set(
      item.exercise_id,
      (exerciseUsage.get(item.exercise_id) || 0) + 1,
    );
  }

  for (const spec of splitPlan) {
    const dayItems = grouped.get(spec.day) || [];
    if (dayItems.length === 0) {
      errors.push(`${formatPlanDay(spec.day)} is missing entirely.`);
      continue;
    }

    if (
      dayItems.length < spec.minExercises
      || dayItems.length > spec.maxExercises
    ) {
      errors.push(
        `${formatPlanDay(spec.day)} must contain ${spec.minExercises}-${spec.maxExercises} exercises.`,
      );
    }

    const patternCounts = {};
    const distinctPatterns = new Set();
    const seenExercises = new Set();
    let estimatedMinutes = 0;

    for (const item of dayItems) {
      const exercise = exercisesById.get(item.exercise_id);
      if (!exercise) {
        errors.push(`${formatPlanDay(spec.day)} contains an invalid exercise id.`);
        continue;
      }

      if (seenExercises.has(item.exercise_id)) {
        errors.push(
          `${formatPlanDay(spec.day)} repeats the same exercise more than once.`,
        );
      }
      seenExercises.add(item.exercise_id);

      const profile = getExerciseProfile(exercise);
      patternCounts[profile.pattern] = (patternCounts[profile.pattern] || 0) + 1;
      distinctPatterns.add(profile.pattern);
      estimatedMinutes += estimateWorkoutItemMinutes(
        item,
        exercise,
        surveyData.fitnessLevel,
      );

      if (item.reps && item.duration) {
        errors.push(
          `${formatPlanDay(spec.day)} has an exercise with both reps and timed duration set.`,
        );
      }
      if (!item.reps && !item.duration) {
        errors.push(
          `${formatPlanDay(spec.day)} has an exercise without reps or timed duration.`,
        );
      }
    }

    for (const [pattern, count] of Object.entries(spec.minPatternCounts)) {
      if ((patternCounts[pattern] || 0) < count) {
        errors.push(
          `${formatPlanDay(spec.day)} needs at least ${count} ${pattern} exercise(s).`,
        );
      }
    }

    for (const group of spec.requiredAnyPatternGroups) {
      const hasAny = group.some(pattern => (patternCounts[pattern] || 0) > 0);
      if (!hasAny) {
        errors.push(
          `${formatPlanDay(spec.day)} must include at least one of: ${group.join(', ')}.`,
        );
      }
    }

    for (const [pattern, maxCount] of Object.entries(spec.maxPatternCounts)) {
      if ((patternCounts[pattern] || 0) > maxCount) {
        errors.push(
          `${formatPlanDay(spec.day)} has too many ${pattern} exercises.`,
        );
      }
    }

    if (distinctPatterns.size < spec.minDistinctPatterns) {
      errors.push(
        `${formatPlanDay(spec.day)} needs more movement-pattern variety.`,
      );
    }

    if (
      estimatedMinutes < spec.minMinutes
      || estimatedMinutes > spec.maxMinutes
    ) {
      errors.push(
        `${formatPlanDay(spec.day)} is outside the ${spec.targetMinutes}-minute session budget.`,
      );
    }
  }

  for (const [exerciseId, count] of exerciseUsage.entries()) {
    if (count > 2) {
      const exercise = exercisesById.get(exerciseId);
      errors.push(
        `${normalizeText(exercise?.name) || `Exercise ${exerciseId}`} is repeated too often across the week.`,
      );
    }
  }

  for (let index = 0; index < dayOrder.length - 1; index += 1) {
    const currentDayItems = grouped.get(dayOrder[index]) || [];
    const nextDayItems = grouped.get(dayOrder[index + 1]) || [];
    const nextIds = new Set(nextDayItems.map(item => item.exercise_id));
    const repeatedNextDay = currentDayItems.some(item => nextIds.has(item.exercise_id));
    if (repeatedNextDay) {
      errors.push(
        `${formatPlanDay(dayOrder[index])} and ${formatPlanDay(dayOrder[index + 1])} repeat the same exercise on consecutive days.`,
      );
    }
  }

  return {
    isValid: errors.length === 0,
    errors: Array.from(new Set(errors)).slice(0, 8),
  };
}

function getRecipeIngredientNames(recipe = {}) {
  return Array.isArray(recipe.ingredients)
    ? recipe.ingredients
        .map(ingredient => normalizeText(ingredient?.name))
        .filter(Boolean)
    : [];
}

function buildIngredientSearchText(recipe = {}) {
  const ingredientText = getRecipeIngredientNames(recipe).join(' ').toLowerCase();
  return ingredientText || normalizeTextLower(recipe.title);
}

function matchesIngredientKeyword(text, keyword) {
  if (!text || !keyword) {
    return false;
  }

  const escapedKeyword = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escapedKeyword}\\b`, 'i').test(text);
}

function matchesAnyIngredientKeyword(text, keywords = []) {
  return keywords.some(keyword => matchesIngredientKeyword(text, keyword));
}

function getCustomAllergyKeywords(value) {
  return normalizeText(value)
    .split(/[\n,;/]+/)
    .map(term => term.trim().toLowerCase())
    .filter(term => term.length >= 3);
}

function parsePrepTimeLimit(prepTime) {
  return PREP_TIME_LIMITS[prepTime] ?? Infinity;
}

function calculateDietTargets(user, goal, mealsPerDay) {
  const goalKey = normalizeGoal(goal || user?.goal);
  const weightKg = toFiniteNumber(user?.weight);
  const heightCm = toFiniteNumber(user?.height);
  const age = calcAge(user?.dob);
  const gender = normalizeTextLower(user?.gender);
  const mealsCount = Math.max(parseInt(mealsPerDay, 10) || 3, 1);

  let maintenanceCalories = null;
  if (weightKg && heightCm && age && ['male', 'female'].includes(gender)) {
    const sexOffset = gender === 'male' ? 5 : -161;
    const bmr = 10 * weightKg + 6.25 * heightCm - 5 * age + sexOffset;
    maintenanceCalories = Math.round(bmr * DEFAULT_DIET_ACTIVITY_MULTIPLIER);
  } else if (weightKg) {
    maintenanceCalories = Math.round(weightKg * 31);
  }

  let dailyCalories = maintenanceCalories;
  if (dailyCalories) {
    if (goalKey === 'weight_loss') dailyCalories -= 400;
    if (goalKey === 'muscle_gain') dailyCalories += 250;
    if (goalKey === 'eat_healthier') dailyCalories -= 100;
    dailyCalories = Math.max(1200, dailyCalories);
  }

  let dailyProtein = null;
  if (weightKg) {
    const proteinPerKg =
      goalKey === 'muscle_gain'
        ? 2
        : goalKey === 'weight_loss'
        ? 1.8
        : 1.6;
    dailyProtein = Math.round(weightKg * proteinPerKg);
  }

  return {
    goalKey,
    maintenanceCalories,
    dailyCalories,
    dailyProtein,
    calorieTolerance: dailyCalories
      ? goalKey === 'weight_loss'
        ? 150
        : 200
      : null,
    perMealCalories: dailyCalories ? Math.round(dailyCalories / mealsCount) : null,
    perMealProtein: dailyProtein
      ? Math.max(15, Math.round(dailyProtein / mealsCount))
      : null,
  };
}

function scoreExerciseCandidate(exercise, surveyData, profile = getExerciseProfile(exercise)) {
  const goalKey = normalizeGoal(surveyData.goal);
  const allowedMuscles = getAllowedMuscles(surveyData.focusAreas);
  const selectedEquipment = getSelectedEquipmentTokens(
    surveyData.equipment,
    surveyData.equipmentOther,
  );
  const safetyContext = buildWorkoutSafetyContext(surveyData);
  const muscle = normalizeTextLower(exercise.muscle);
  const type = normalizeTextLower(exercise.type);
  const equipment = normalizeTextLower(exercise.equipment);
  const trainingExperience = normalizeTextLower(surveyData.trainingExperience);
  const hasConstraints =
    (surveyData.healthConditions || []).some(item => item && item !== 'None')
    || (surveyData.medicationFactors || []).some(
      item => item && item !== 'No' && item !== 'Prefer not to say',
    );

  let score = 0;

  if (allowedMuscles?.has(muscle)) score += 45;
  if ((surveyData.focusAreas || []).includes('Upper body') && ['push', 'pull'].includes(profile.pattern)) {
    score += 10;
  }
  if ((surveyData.focusAreas || []).includes('Lower body') && profile.pattern === 'lower') {
    score += 10;
  }
  if ((surveyData.focusAreas || []).includes('Core') && profile.pattern === 'core') {
    score += 12;
  }
  if (!equipment && selectedEquipment.has('')) score += 10;
  if (equipment && Array.from(selectedEquipment).some(token => token && equipment.includes(token))) {
    score += 14;
  }
  if (getWorkoutDurationMinutes(surveyData.duration) <= 30 && profile.isCompound) {
    score += 8;
  }
  if (getWorkoutDurationMinutes(surveyData.duration) <= 15 && ['mobility', 'cardio'].includes(profile.pattern)) {
    score -= 4;
  }

  if (goalKey === 'muscle_gain') {
    if (type.includes('strength')) score += 18;
    if (type.includes('power')) score += 10;
    if (profile.pattern === 'cardio') score -= 6;
  }
  if (goalKey === 'weight_loss') {
    if (type.includes('cardio')) score += 18;
    if (type.includes('plyometric')) score += 10;
    if (type.includes('strength')) score += 8;
  }
  if (goalKey === 'improve_endurance' && type.includes('cardio')) score += 20;
  if (goalKey === 'recovery') {
    if (type.includes('stretch')) score += 22;
    if (type.includes('mobility')) score += 18;
  }
  if (goalKey === 'stay_active') {
    if (type.includes('cardio')) score += 8;
    if (type.includes('strength')) score += 8;
  }

  if (
    ['none', 'less than 3 months'].includes(trainingExperience)
    || normalizeTextLower(surveyData.fitnessLevel) === 'beginner'
  ) {
    if (!equipment || equipment.includes('body only')) score += 8;
    if (equipment.includes('machine') || equipment.includes('band')) score += 6;
    if (equipment.includes('barbell')) score -= 4;
  }

  if (hasConstraints && normalizeText(exercise.safety_info)) score += 8;
  if (normalizeText(exercise.instructions)) score += 3;
  if (violatesWorkoutSafety(profile, safetyContext)) score -= 30;
  else if (violatesWorkoutSafety(profile, safetyContext, 'relaxed')) score -= 12;

  return score;
}

function rankWorkoutCandidates(exercises, surveyData, splitPlan = []) {
  const scored = exercises
    .map((exercise, index) => {
      const profile = getExerciseProfile(exercise);
      return {
        exercise,
        index,
        profile,
        score: scoreExerciseCandidate(exercise, surveyData, profile),
      };
    })
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return left.index - right.index;
    });

  const desiredPatterns = new Set();
  splitPlan.forEach(spec => {
    Object.keys(spec.minPatternCounts || {}).forEach(pattern => {
      desiredPatterns.add(pattern);
    });
    (spec.requiredAnyPatternGroups || []).forEach(group => {
      group.forEach(pattern => desiredPatterns.add(pattern));
    });
  });

  const selected = [];
  const selectedIds = new Set();
  const patternCounts = {};
  const addEntry = entry => {
    if (selectedIds.has(entry.exercise.id) || selected.length >= MAX_WORKOUT_PROMPT_EXERCISES) {
      return;
    }

    selected.push(entry.exercise);
    selectedIds.add(entry.exercise.id);
    patternCounts[entry.profile.pattern] =
      (patternCounts[entry.profile.pattern] || 0) + 1;
  };

  desiredPatterns.forEach(pattern => {
    const minimumForPattern = pattern === 'core' ? 3 : 4;
    for (const entry of scored) {
      if ((patternCounts[pattern] || 0) >= minimumForPattern) {
        break;
      }
      if (entry.profile.pattern === pattern) {
        addEntry(entry);
      }
    }
  });

  [8, 12, Number.POSITIVE_INFINITY].forEach(cap => {
    for (const entry of scored) {
      if (selected.length >= MAX_WORKOUT_PROMPT_EXERCISES) {
        break;
      }

      const currentCount = patternCounts[entry.profile.pattern] || 0;
      if (currentCount >= cap) {
        continue;
      }
      addEntry(entry);
    }
  });

  return selected;
}

function scoreRecipeCandidate(recipe, surveyData, nutritionTargets) {
  const goalKey = nutritionTargets.goalKey;
  const cuisineSet = new Set(
    (surveyData.preferredCuisines || []).map(value => String(value).toLowerCase()),
  );
  const useCuisineFilter = cuisineSet.size > 0 && !cuisineSet.has('any');
  const tagSet = new Set((recipe.tags || []).map(tag => String(tag).toLowerCase()));
  const prepLimit = parsePrepTimeLimit(surveyData.prepTime);
  const prepMinutes = toFiniteNumber(recipe.ready_in_minutes) || 0;
  const calories = toFiniteNumber(recipe.calories) || 0;
  const protein = toFiniteNumber(recipe.protein) || 0;
  const cuisine = normalizeTextLower(recipe.cuisine);

  let score = 0;

  if (useCuisineFilter && cuisineSet.has(cuisine)) score += 18;
  if (Number.isFinite(prepLimit)) {
    if (prepMinutes <= prepLimit) {
      score += 12;
    } else {
      score -= Math.min(18, Math.ceil((prepMinutes - prepLimit) / 10) * 3);
    }
  }

  if (nutritionTargets.perMealCalories) {
    score += Math.max(
      0,
      20 - Math.abs(calories - nutritionTargets.perMealCalories) / 25,
    );
  }
  if (nutritionTargets.perMealProtein) {
    score += Math.max(
      0,
      18 - Math.abs(protein - nutritionTargets.perMealProtein) / 2,
    );
  }

  if (goalKey === 'weight_loss') {
    if (tagSet.has('weight_loss')) score += 18;
    if (tagSet.has('low_fat')) score += 8;
    if (tagSet.has('high_protein')) score += 10;
    score += Math.min(14, protein * 0.45);
  }
  if (goalKey === 'muscle_gain') {
    if (tagSet.has('muscle_gain')) score += 18;
    if (tagSet.has('high_protein')) score += 12;
    score += Math.min(18, protein * 0.5);
  }
  if (goalKey === 'eat_healthier' || goalKey === 'maintenance') {
    if (tagSet.has('high_protein')) score += 8;
    if (tagSet.has('quick_meal')) score += 6;
    if (tagSet.has('easy')) score += 4;
  }

  if (surveyData.dietType === 'Vegetarian' && recipe.vegetarian) score += 8;
  if (surveyData.dietType === 'Vegan' && recipe.vegan) score += 8;
  if ((surveyData.allergies || []).includes('Gluten') && recipe.gluten_free) score += 8;

  return score;
}

function rankDietCandidates(recipes, surveyData, nutritionTargets) {
  return recipes
    .map((recipe, index) => ({
      recipe,
      index,
      score: scoreRecipeCandidate(recipe, surveyData, nutritionTargets),
    }))
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return left.index - right.index;
    })
    .slice(0, MAX_DIET_PROMPT_RECIPES)
    .map(entry => entry.recipe);
}

function formatExercisePromptLine(
  exercise,
  {includeSafetyDetails = false} = {},
) {
  const profile = getExerciseProfile(exercise);
  const fields = [
    `id:${exercise.id}`,
    `name:${normalizeText(exercise.name) || 'unknown'}`,
    `muscle:${normalizeText(exercise.muscle) || 'unknown'}`,
    `equipment:${normalizeText(exercise.equipment) || 'body weight only'}`,
    `difficulty:${normalizeText(exercise.difficulty) || 'unknown'}`,
    `type:${normalizeText(exercise.type) || 'unknown'}`,
    `pattern:${profile.pattern}`,
    `compound:${profile.isCompound ? 'yes' : 'no'}`,
  ];

  if (includeSafetyDetails && profile.riskFlags.size > 0) {
    fields.push(`caution:${Array.from(profile.riskFlags).join(', ')}`);
  }

  if (includeSafetyDetails) {
    const safetyInfo = truncateText(exercise.safety_info, 80);
    if (safetyInfo) {
      fields.push(`safety:${safetyInfo}`);
    }

    const instructions = truncateText(exercise.instructions, 80);
    if (instructions) {
      fields.push(`instructions:${instructions}`);
    }
  }

  return fields.join(' | ');
}

function formatRecipePromptLine(recipe) {
  const tags = (recipe.tags || []).slice(0, MAX_RECIPE_PROMPT_TAGS).join(', ') || 'none';
  const ingredients =
    getRecipeIngredientNames(recipe)
      .slice(0, MAX_RECIPE_PROMPT_INGREDIENTS)
      .join(', ') || 'not listed';
  const dietFlags = [
    recipe.vegetarian && 'vegetarian',
    recipe.vegan && 'vegan',
    recipe.gluten_free && 'gluten_free',
  ]
    .filter(Boolean)
    .join(', ') || 'standard';

  return [
    `id:${recipe.id}`,
    `title:${normalizeText(recipe.title) || 'unknown'}`,
    `cuisine:${normalizeText(recipe.cuisine) || 'unspecified'}`,
    `cal:${toFiniteNumber(recipe.calories) || 0}`,
    `protein:${toFiniteNumber(recipe.protein) || 0}g`,
    `carbs:${toFiniteNumber(recipe.carbs) || 0}g`,
    `fat:${toFiniteNumber(recipe.fat) || 0}g`,
    `prep:${toFiniteNumber(recipe.ready_in_minutes) || 0}min`,
    `tags:${tags}`,
    `diets:${dietFlags}`,
    `ingredients:${truncateText(ingredients, 90)}`,
  ].join(' | ');
}

function filterExercises(allExercises, { fitnessLevel, equipment, equipmentOther }) {
  const difficulty = DIFFICULTY_MAP[fitnessLevel] || 'beginner';
  const equipmentTokens = Array.from(
    getSelectedEquipmentTokens(equipment, equipmentOther),
  );

  return allExercises.filter(e => {
    const diffOk = e.difficulty === difficulty;
    const equip = (e.equipment || '').toLowerCase();
    const equipOk =
      equip === ''
      || equipmentTokens.some(token => token !== '' && equip.includes(token));
    return diffOk && equipOk;
  });
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
    days: getWorkoutPlanDays(surveyData).map(formatPlanDay),
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
    preferredCuisines: sanitizedPreferredCuisines,
    planDays,
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
- Produce a materially different weekly meal plan from the previous version while still matching the user's profile.
- Prioritize fixing the issue above.
- Avoid repeating the same exact meal pattern from the previous plan unless necessary.
`;
}

function buildWorkoutSafetyPrompt(surveyData) {
  const safetyContext = buildWorkoutSafetyContext(surveyData);
  const rules = [];

  if (safetyContext.avoidSpinalLoad) {
    rules.push('Avoid heavy spinal loading and loaded bent-over positions.');
  }
  if (safetyContext.avoidHighImpact) {
    rules.push('Avoid high-impact or jumping-heavy exercise selections.');
  }
  if (safetyContext.avoidKneeStress) {
    rules.push('Avoid aggressive knee-stress patterns when safer alternatives exist.');
  }
  if (safetyContext.avoidIntenseConditioning) {
    rules.push('Avoid all-out conditioning or heart-rate-spiking intervals.');
  }
  if (safetyContext.avoidBallistic) {
    rules.push('Favor controlled tempo over explosive or ballistic work.');
  }

  return rules.length ? rules.map(rule => `- ${rule}`).join('\n') : '';
}

function buildPrompt(user, surveyData, exercises, previousPlan, splitPlan) {
  const {
    goal,
    fitnessLevel,
    trainingExperience,
    equipment,
    equipmentOther,
    duration,
    healthConditions,
    healthConditionsOther,
    medicationFactors,
    medicationFactorsOther,
    focusAreas,
    additionalNote,
  } = surveyData;

  // Clean 'None'/'Unsure' values before building prompt strings
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

  const planDays = getWorkoutPlanDays(surveyData);
  const splitPlanText = formatWorkoutSplitPlan(splitPlan);
  const safetyPrompt = buildWorkoutSafetyPrompt(surveyData);
  const includeSafetyDetails = hasWorkoutHealthOrMedicationConstraints(
    surveyData,
  );
  const exerciseData = exercises
    .map(exercise =>
      formatExercisePromptLine(exercise, {includeSafetyDetails}),
    )
    .join('\n');

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
${additionalNote ? `- Additional note: ${additionalNote}
` : ''}

Weekly structure to follow exactly:
${splitPlanText}
${safetyPrompt ? `
Extra safety rules:
${safetyPrompt}
` : ''}

Exercise data (pre-ranked for fit):
${exerciseData}
${regenerationContext ? `
${regenerationContext}` : ''}

Task:
Create a weekly workout plan.

Rules:
- Use ONLY provided exercises (reference by exercise_id)
- Prefer the exercises that best match the target muscles, goal, equipment, and safety context from the ranked list above.
- Follow the daily split and structure above exactly.
- Match ${(fitnessLevel || 'Beginner').toLowerCase()} difficulty
- Use current fitness level as the baseline difficulty, and use prior training experience only to adjust exercise familiarity, progression, and variety without exceeding that difficulty.
- Match the listed exercise-count range and duration target for each day.
- If medication/substance factors are present, keep the plan safety-first and avoid unnecessarily extreme intensity, volume, or conditioning demands.
- For timed exercises (planks, holds), set reps to 0 and duration to seconds (e.g. 30)
- For rep-based exercises, set duration to 0

Output format STRICTLY (no extra text, no markdown):
${outputFormat}`;
}

function parseWorkoutResponse(raw, planDays) {
  const items = [];
  const allowedDaySet = new Set((planDays || []).map(day => day.toLowerCase()));
  let currentDay = null;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim().toLowerCase();
    const dayMatch = WORKOUT_DAY_ORDER.find(d => trimmed.startsWith(d));
    if (dayMatch) {
      currentDay = allowedDaySet.has(dayMatch) ? dayMatch : null;
      continue;
    }
    if (!currentDay) continue;
    // match: - exercise_id: 12, sets: 3, reps: 10
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

function buildWorkoutRetryPrompt(basePrompt, errors) {
  return `${basePrompt}

Your previous response was invalid. Regenerate the entire weekly workout plan from scratch and fix these issues:
- ${errors.join('\n- ')}

Follow the daily split, movement-pattern requirements, time budgets, and exact output format.`;
}

async function generateValidatedWorkoutItems(
  prompt,
  promptExercises,
  splitPlan,
  surveyData,
) {
  const planDays = splitPlan.map(spec => spec.day);
  const exercisesById = new Map(promptExercises.map(exercise => [exercise.id, exercise]));
  const validIds = new Set(promptExercises.map(exercise => exercise.id));
  let attemptPrompt = prompt;
  let lastErrors = ['AI generation failed'];
  let lastRaw = '';

  for (let attempt = 1; attempt <= MAX_WORKOUT_GENERATION_ATTEMPTS; attempt += 1) {
    const raw = await askGemini(attemptPrompt);
    lastRaw = raw;
    console.log(`Gemini raw response (attempt ${attempt}):`, raw?.slice(0, 500));

    const parsedItems = parseWorkoutResponse(raw, planDays);
    console.log(`Parsed items (attempt ${attempt}):`, parsedItems.length, parsedItems.slice(0, 3));
    if (parsedItems.length === 0) {
      lastErrors = ['Failed to parse AI response'];
      attemptPrompt = buildWorkoutRetryPrompt(prompt, lastErrors);
      continue;
    }

    const candidateItems = parsedItems.filter(item => validIds.has(item.exercise_id));
    const validation = validateWorkoutPlan(
      candidateItems,
      exercisesById,
      splitPlan,
      surveyData,
    );

    if (validation.isValid) {
      return {raw, items: candidateItems};
    }

    lastErrors = validation.errors;
    attemptPrompt = buildWorkoutRetryPrompt(prompt, validation.errors);
  }

  const error = new Error(lastErrors.join(' '));
  error.raw = lastRaw;
  throw error;
}

async function runWorkoutGeneration(userId, surveyData) {
  const user = await User.findById(userId);
  if (!user) {
    throw new Error('User not found');
  }

  const {fitnessLevel, equipment, equipmentOther, focusAreas} = surveyData;
  const planDays = getWorkoutPlanDays(surveyData);
  const splitPlan = buildWorkoutSplitPlan(planDays, surveyData);

  const allExercises = await Exercise.find(
    {},
    'id name muscle equipment difficulty type instructions safety_info',
  );
  const filtered = filterExercises(allExercises, {
    fitnessLevel,
    equipment,
    equipmentOther,
    focusAreas,
  });
  const safeExercises = applyWorkoutSafetyFilters(filtered, surveyData);
  const promptExercises = rankWorkoutCandidates(
    safeExercises,
    surveyData,
    splitPlan,
  );

  if (promptExercises.length === 0) {
    throw new Error('No matching exercises found for your profile');
  }

  const previousPlan = surveyData.previousPlanId
    ? await WorkoutPlan.findById(surveyData.previousPlanId)
    : null;

  const prompt = buildPrompt(
    user,
    surveyData,
    promptExercises,
    previousPlan,
    splitPlan,
  );
  console.log('Prompt preview:', prompt.slice(0, 300));

  try {
    const {items} = await generateValidatedWorkoutItems(
      prompt,
      promptExercises,
      splitPlan,
      surveyData,
    );

    const plan = await WorkoutPlan.create({
      user_id: userId,
      generated_by: 'ai',
      status: 'draft',
      survey_input: JSON.stringify(buildWorkoutSurveyInputForStorage(surveyData)),
      items,
    });

    return {plan};
  } catch (geminiErr) {
    console.error('Gemini error:', geminiErr?.response?.data || geminiErr.message || geminiErr.raw);
    throw new Error(geminiErr?.message || 'AI generation failed');
  }
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
  {dietType, allergies, allergiesOther, preferredCuisines},
) {
  const allergySet = new Set(
    (allergies || []).filter(a => a !== 'None').map(a => a.toLowerCase()),
  );
  const customAllergyKeywords = getCustomAllergyKeywords(allergiesOther);
  const cuisineSet = new Set(
    (preferredCuisines || []).map(value => String(value).toLowerCase()),
  );
  const useCuisineFilter = cuisineSet.size > 0 && !cuisineSet.has('any');

  return allRecipes.filter(r => {
    const ingredientSearchText = buildIngredientSearchText(r);

    if (dietType === 'Vegetarian' && !r.vegetarian) return false;
    if (dietType === 'Vegan' && !r.vegan) return false;
    if (dietType === 'Keto' && r.carbs > 10) return false;
    if (
      allergySet.has('gluten')
      && (!r.gluten_free
        || matchesAnyIngredientKeyword(
          ingredientSearchText,
          GLUTEN_INGREDIENT_KEYWORDS,
        ))
    ) {
      return false;
    }
    if (
      allergySet.has('dairy')
      && matchesAnyIngredientKeyword(
        ingredientSearchText,
        DAIRY_INGREDIENT_KEYWORDS,
      )
    ) {
      return false;
    }
    if (
      allergySet.has('nuts')
      && matchesAnyIngredientKeyword(
        ingredientSearchText,
        NUT_INGREDIENT_KEYWORDS,
      )
    ) {
      return false;
    }
    if (
      customAllergyKeywords.some(keyword =>
        matchesIngredientKeyword(ingredientSearchText, keyword),
      )
    ) {
      return false;
    }
    if (useCuisineFilter && !cuisineSet.has((r.cuisine || '').toLowerCase())) return false;
    return true;
  });
}

function buildDietPrompt(
  user,
  surveyData,
  recipes,
  location,
  previousPlan,
  nutritionTargets,
) {
  const {
    goal,
    dietType,
    allergies,
    allergiesOther,
    preferredCuisines,
    mealsPerDay,
    prepTime,
    flexibleMealPreference,
    flexibleMealDetails,
    additionalNote,
  } = surveyData;
  const allergyStr = (allergies || []).filter(a => a !== 'None').concat(allergiesOther ? [allergiesOther] : []).join(', ') || 'none';
  const mealsCount = parseInt(mealsPerDay) || 3;
  const age = calcAge(user.dob);
  const flexiblePreference = flexibleMealPreference || 'No flexibility';
  const plannedDays = getDietPlanDays(surveyData);
  const plannedDaySet = new Set(plannedDays);
  const planDayLabels = plannedDays.map(formatPlanDay);
  const skippedDayLabels = DIET_PLAN_DAYS
    .filter(day => !plannedDaySet.has(day))
    .map(formatPlanDay);
  const preferredCuisineLabels = (preferredCuisines || []).filter(
    cuisine => cuisine && cuisine !== 'Any',
  );
  const legacyFlexibilityLine =
    !Array.isArray(surveyData.planDays)
    && flexiblePreference !== 'No flexibility'
    && flexiblePreference !== 'No cheat days'
      ? `${flexiblePreference}${
          flexibleMealDetails ? ` (${flexibleMealDetails})` : ''
        }`
      : null;

  const MEAL_SETS = {
    2: ['breakfast', 'dinner'],
    3: ['breakfast', 'lunch', 'dinner'],
    4: ['breakfast', 'lunch', 'dinner', 'snack'],
    5: ['breakfast', 'morning_snack', 'lunch', 'afternoon_snack', 'dinner'],
  };
  const MEAL_TYPES = MEAL_SETS[mealsCount] || MEAL_SETS[3];

  const recipeData = recipes.map(formatRecipePromptLine).join('\n');
  const calorieTargetLine = nutritionTargets.dailyCalories
    ? `- Daily calorie target: around ${nutritionTargets.dailyCalories} kcal (within about +/- ${nutritionTargets.calorieTolerance} kcal)
`
    : '';
  const proteinTargetLine = nutritionTargets.dailyProtein
    ? `- Daily protein target: at least ${nutritionTargets.dailyProtein} g
`
    : '';
  const perMealTargetLine =
    nutritionTargets.perMealCalories || nutritionTargets.perMealProtein
      ? `- Approx per-meal target: ${nutritionTargets.perMealCalories ? `${nutritionTargets.perMealCalories} kcal` : 'flexible calories'}${nutritionTargets.perMealProtein ? ` and ${nutritionTargets.perMealProtein} g protein` : ''}
`
      : '';

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
- Preferred cuisines: ${preferredCuisineLabels.length ? preferredCuisineLabels.join(', ') : 'any'}
- Allergies: ${allergyStr}
- Meals per day: ${mealsCount}
- Prep time available: ${prepTime || 'no limit'}
- Meal plan days: ${planDayLabels.join(', ')}
${calorieTargetLine}${proteinTargetLine}${perMealTargetLine}${legacyFlexibilityLine ? `- Flexibility preference: ${legacyFlexibilityLine}
` : ''}${skippedDayLabels.length ? `- Days without planned meals: ${skippedDayLabels.join(', ')}
` : ''}
${additionalNote ? `- Additional note: ${additionalNote}
` : ''}

Recipe data (pre-ranked for fit):
${recipeData}
${regenerationContext ? `
${regenerationContext}` : ''}

Task:
Create a weekly diet plan.

Rules:
- Use ONLY provided recipes (reference by recipe_id)
- Prefer the higher-ranked recipes that best match prep time, cuisine, protein, and calorie needs.
- Generate meals only for these days: ${planDayLabels.join(', ')}
- Do not generate any meals for days not listed above${skippedDayLabels.length ? ` (${skippedDayLabels.join(', ')})` : ''}
- Each planned day must have exactly ${mealsCount} meals: ${MEAL_TYPES.join(', ')}
- Vary recipes across days, avoid repeating the same recipe more than twice
- Respect the user's diet type and allergies
- ${nutritionTargets.dailyCalories ? `Keep each planned day close to ${nutritionTargets.dailyCalories} kcal (within about +/- ${nutritionTargets.calorieTolerance} kcal) when the recipe pool allows it.` : 'Keep daily energy aligned to the user goal as closely as the recipe pool allows.'}
- ${nutritionTargets.dailyProtein ? `Aim for at least ${nutritionTargets.dailyProtein} g protein per planned day, distributing protein across meals.` : 'Favor protein-balanced meal choices across the day.'}
- Omit all non-selected days entirely from the plan output.
- If legacy flexibility preferences are present, accommodate them while keeping the overall week aligned to the user's goal.
- For "Weekends more flexible", prefer placing the more flexible choices on Saturday and Sunday.
- For "1 flexible day per week" with no custom day specified, default to Saturday.
- Legacy flexibility handling must still use only the provided recipes and should not turn the whole week off-plan.
- Only assign solid food meals for breakfast, lunch, and dinner — drinks, smoothies, shakes, or juices should only be assigned as snacks if appropriate

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
    dietType,
    allergies,
    allergiesOther,
    preferredCuisines,
    latitude,
    longitude,
  } = surveyData;
  const location = surveyData.location
    ? surveyData.location
    : (latitude && longitude)
    ? await reverseGeocode(latitude, longitude)
    : {city: null, country: null};
  console.log('[Diet] location:', location);

  const previousPlan = surveyData.previousPlanId
    ? await DietPlan.findById(surveyData.previousPlanId)
    : null;
  const plannedDays = getDietPlanDays(surveyData);
  const plannedDaySet = new Set(plannedDays.map(formatPlanDay));
  const nutritionTargets = calculateDietTargets(
    user,
    surveyData.goal || user.goal,
    surveyData.mealsPerDay,
  );

  const Recipe = require('../recipe/recipe.model');
  const allRecipes = await Recipe.findAll();
  const filtered = filterRecipes(allRecipes, {
    dietType,
    allergies,
    allergiesOther,
    preferredCuisines,
  });
  const promptRecipes = rankDietCandidates(
    filtered,
    surveyData,
    nutritionTargets,
  );
  if (promptRecipes.length === 0) {
    throw new Error('No matching recipes found for your profile');
  }

  const prompt = buildDietPrompt(
    user,
    surveyData,
    promptRecipes,
    location,
    previousPlan,
    nutritionTargets,
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

  const validIds = new Set(promptRecipes.map(r => r.id));
  const validItems = items.filter(
    i => validIds.has(i.recipe_id) && plannedDaySet.has(i.day),
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
