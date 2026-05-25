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
  'Upper body': ['chest', 'biceps', 'triceps', 'shoulders', 'traps', 'lats', 'middle_back' 'lower_back', 'neck', 'forearms'],
  'Lower body': ['quadriceps', 'hamstrings', 'glutes', 'calves', 'adductors', 'abductors'],
  'Core': ['abdominals', 'lower_back'],
  'Full body': null,
  'Unsure': null,
};

function filterExercises(allExercises, { fitnessLevel, equipment, equipmentOther, focusAreas }) {
  const difficulty = DIFFICULTY_MAP[fitnessLevel] || 'beginner';

  // Build allowed equipment set — ignore 'None'
  const cleanEquipment = (equipment || []).filter(e => e !== 'None');
  const hasGym = cleanEquipment.includes('Full gym');
  const equipmentList = [];
  if (!cleanEquipment.length) equipmentList.push('body only', '');
  if (cleanEquipment.includes('Dumbbells')) equipmentList.push('dumbbell');
  if (cleanEquipment.includes('Resistance bands')) equipmentList.push('band');
  if (hasGym) equipmentList.push('barbell', 'cable', 'machine', 'e-z curl bar', 'ez curl', 'kettlebell', 'medicine ball', 'exercise ball', 'foam roll', 'other', 'bench', 'rack', 'pull-up', 'dip');
  if (equipmentOther) equipmentList.push(equipmentOther.toLowerCase());
  // always allow body-weight exercises (empty equipment)
  equipmentList.push('');

  // Build allowed muscles set — ignore 'Full body' and 'Unsure'
  const cleanFocus = (focusAreas || []).filter(f => f !== 'Full body' && f !== 'Unsure');
  let allowedMuscles = null;
  if (cleanFocus.length) {
    allowedMuscles = new Set();
    for (const area of cleanFocus) {
      const muscles = FOCUS_MUSCLE_MAP[area];
      if (muscles) muscles.forEach(m => allowedMuscles.add(m));
    }
  }

  return allExercises.filter(e => {
    const diffOk = e.difficulty === difficulty;
    const equip = (e.equipment || '').toLowerCase();
    const equipOk = equip === '' || equipmentList.some(eq => eq !== '' && equip.includes(eq));
    const muscleOk = !allowedMuscles || allowedMuscles.has((e.muscle || '').toLowerCase());
    return diffOk && equipOk && muscleOk;
  }).slice(0, 50);
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
    additionalNote: typeof body.additionalNote === 'string'
      ? body.additionalNote.trim()
      : '',
  };
}

function normalizeDietSurveyData(body = {}) {
  return {
    ...body,
    additionalNote: typeof body.additionalNote === 'string'
      ? body.additionalNote.trim()
      : '',
  };
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

function buildPrompt(user, surveyData, exercises, previousPlan) {
  const {
    goal,
    fitnessLevel,
    equipment,
    equipmentOther,
    days,
    duration,
    healthConditions,
    healthConditionsOther,
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

  const cleanFocus = (focusAreas || []).filter(f => f !== 'Full body' && f !== 'Unsure');
  const focusStr = cleanFocus.length ? cleanFocus.join(', ').toLowerCase() : 'full body';

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
- Equipment: ${equipmentStr}
- Days: ${planDays.join(', ')}
- Duration per session: ${duration || '45 min'}
- Focus: ${focusStr}
- Health conditions: ${conditionsStr}
${additionalNote ? `- Additional note: ${additionalNote}
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
- Each day should contain 3-5 exercises
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

async function runWorkoutGeneration(userId, surveyData) {
  const user = await User.findById(userId);
  if (!user) {
    throw new Error('User not found');
  }

  const {fitnessLevel, equipment, equipmentOther, days, focusAreas} = surveyData;
  const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const planDays = days && days.length
    ? days.map(d => d.toLowerCase())
    : DAYS.slice(0, 5).map(d => d.toLowerCase());

  const allExercises = await Exercise.find({}, 'id name muscle equipment difficulty');
  const filtered = filterExercises(allExercises, {
    fitnessLevel,
    equipment,
    equipmentOther,
    focusAreas,
  });

  if (filtered.length === 0) {
    throw new Error('No matching exercises found for your profile');
  }

  const previousPlan = surveyData.previousPlanId
    ? await WorkoutPlan.findById(surveyData.previousPlanId)
    : null;

  const prompt = buildPrompt(user, surveyData, filtered, previousPlan);
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
    survey_input: JSON.stringify({
      goal: surveyData.goal,
      fitnessLevel: surveyData.fitnessLevel,
      equipment: surveyData.equipment,
      equipmentOther: surveyData.equipmentOther,
      days: surveyData.days,
      duration: surveyData.duration,
      focusAreas: surveyData.focusAreas,
      healthConditions: surveyData.healthConditions,
      healthConditionsOther: surveyData.healthConditionsOther,
      additionalNote: surveyData.additionalNote || null,
      regenerationFeedback: surveyData.regenerationFeedback || null,
      regeneratedFromPlanId: surveyData.previousPlanId || null,
    }),
    items: validItems,
  });

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

    if (previousPlan.status === 'draft') {
      return res.status(400).json({
        error:
          'This plan is still pending review. Wait for review before regenerating.',
      });
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

function filterRecipes(allRecipes, { dietType, allergies, allergiesOther }) {
  const allergySet = new Set(
    (allergies || []).filter(a => a !== 'None').map(a => a.toLowerCase())
      .concat(allergiesOther ? [allergiesOther.toLowerCase()] : [])
  );
  return allRecipes.filter(r => {
    if (dietType === 'Vegetarian' && !r.vegetarian) return false;
    if (dietType === 'Vegan' && !r.vegan) return false;
    if (dietType === 'Keto' && r.carbs > 10) return false;
    if (allergySet.has('gluten') && !r.gluten_free) return false;
    if (allergySet.has('dairy') && (r.title || '').toLowerCase().match(/\b(milk|cheese|cream|butter|yogurt)\b/)) return false;
    if (allergySet.has('nuts') && (r.title || '').toLowerCase().match(/\b(nut|almond|cashew|walnut|pecan|pistachio)\b/)) return false;
    return true;
  }).slice(0, 40);
}

function buildDietPrompt(user, surveyData, recipes, location, previousPlan) {
  const {
    goal,
    dietType,
    allergies,
    allergiesOther,
    mealsPerDay,
    prepTime,
    additionalNote,
  } = surveyData;
  const allergyStr = (allergies || []).filter(a => a !== 'None').concat(allergiesOther ? [allergiesOther] : []).join(', ') || 'none';
  const mealsCount = parseInt(mealsPerDay) || 3;
  const age = calcAge(user.dob);

  const MEAL_SETS = {
    2: ['breakfast', 'dinner'],
    3: ['breakfast', 'lunch', 'dinner'],
    4: ['breakfast', 'lunch', 'dinner', 'snack'],
    5: ['breakfast', 'morning_snack', 'lunch', 'afternoon_snack', 'dinner'],
  };
  const MEAL_TYPES = MEAL_SETS[mealsCount] || MEAL_SETS[3];
  const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

  const recipeData = recipes.map(r =>
    `id:${r.id} | ${r.title} | cal:${r.calories} | protein:${r.protein}g | carbs:${r.carbs}g | fat:${r.fat}g | prep:${r.ready_in_minutes}min`
  ).join('\n');

  const outputFormat = DAYS.map(day =>
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
${additionalNote ? `- Additional note: ${additionalNote}
` : ''}

Recipe data:
${recipeData}
${regenerationContext ? `
${regenerationContext}` : ''}

Task:
Create a 7-day diet plan.

Rules:
- Use ONLY provided recipes (reference by recipe_id)
- Each day must have exactly ${mealsCount} meals: ${MEAL_TYPES.join(', ')}
- Vary recipes across days, avoid repeating the same recipe more than twice
- Respect the user's diet type and allergies
- Only assign solid food meals for breakfast, lunch, and dinner — drinks, smoothies, shakes, or juices should only be assigned as snacks if appropriate

Output format STRICTLY (no extra text, no markdown):
${outputFormat}`;
}

function parseDietResponse(raw) {
  const items = [];
  for (const line of raw.split('\n')) {
    const match = line.match(/day:\s*(\w+),\s*meal_type:\s*([\w_]+),\s*recipe_id:\s*(\d+)/);
    if (match) {
      items.push({
        day: match[1].charAt(0).toUpperCase() + match[1].slice(1).toLowerCase(),
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

  const {dietType, allergies, allergiesOther, latitude, longitude} = surveyData;
  const location = surveyData.location
    ? surveyData.location
    : (latitude && longitude)
    ? await reverseGeocode(latitude, longitude)
    : {city: null, country: null};
  console.log('[Diet] location:', location);

  const previousPlan = surveyData.previousPlanId
    ? await DietPlan.findById(surveyData.previousPlanId)
    : null;

  const Recipe = require('../recipe/recipe.model');
  const allRecipes = await Recipe.findAll();
  const filtered = filterRecipes(allRecipes, {dietType, allergies, allergiesOther});
  if (filtered.length === 0) {
    throw new Error('No matching recipes found for your profile');
  }

  const prompt = buildDietPrompt(
    user,
    surveyData,
    filtered,
    location,
    previousPlan,
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

  const items = parseDietResponse(raw);
  console.log('[Diet] Parsed items:', items.length, items.slice(0, 3));
  if (items.length === 0) {
    throw new Error('Failed to parse AI response');
  }

  const validIds = new Set(filtered.map(r => r.id));
  const validItems = items.filter(i => validIds.has(i.recipe_id));

  const plan = await DietPlan.create({
    user_id: userId,
    status: 'draft',
    survey_input: JSON.stringify({
      goal: surveyData.goal,
      dietType: surveyData.dietType,
      allergies: surveyData.allergies,
      allergiesOther: surveyData.allergiesOther,
      mealsPerDay: surveyData.mealsPerDay,
      prepTime: surveyData.prepTime,
      additionalNote: surveyData.additionalNote || null,
      location,
      regenerationFeedback: surveyData.regenerationFeedback || null,
      regeneratedFromPlanId: surveyData.previousPlanId || null,
    }),
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

    if (previousPlan.status === 'draft') {
      return res.status(400).json({
        error:
          'This plan is still pending review. Wait for review before regenerating.',
      });
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
