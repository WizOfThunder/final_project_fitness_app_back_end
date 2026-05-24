const axios = require('axios');
const Recipe = require('./recipe.model');

function getNutrient(recipe, name) {
  const nutrient = recipe.nutrition?.nutrients?.find(n => n.name === name);
  return nutrient ? nutrient.amount : 0;
}

function generateTags(recipe) {
  const tags = [];
  const { calories, protein, fat, carbs, readyInMinutes, ingredientCount, vegetarian, vegan, glutenFree } = recipe;

  if (protein >= 25) tags.push('high_protein');
  if (carbs <= 30) tags.push('low_carb');
  if (fat <= 10) tags.push('low_fat');
  if (calories <= 400) tags.push('weight_loss');
  if (protein >= 25 && calories >= 400) tags.push('muscle_gain');
  if (readyInMinutes <= 20) tags.push('quick_meal');
  if (ingredientCount > 0 && ingredientCount <= 5) tags.push('easy');
  if (vegetarian) tags.push('vegetarian');
  if (vegan) tags.push('vegan');
  if (glutenFree) tags.push('gluten_free');

  return tags;
}

exports.syncRecipes = async (req, res) => {
  try {
    const {
      query = '',
      number = 20,
      offset = 0,
      diet,
      maxCalories,
      minProtein,
      maxReadyTime,
      cuisine,
      type
    } = req.body;

    const parsedNumber = Math.max(Number.parseInt(number, 10) || 20, 1);
    const parsedOffset = Math.max(Number.parseInt(offset, 10) || 0, 0);

    const params = {
      query,
      number: parsedNumber,
      offset: parsedOffset,
      addRecipeNutrition: true,
      apiKey: process.env.SPOONACULAR_API_KEY
    };

    if (diet) params.diet = diet;
    if (maxCalories) params.maxCalories = maxCalories;
    if (minProtein) params.minProtein = minProtein;
    if (maxReadyTime) params.maxReadyTime = maxReadyTime;
    if (cuisine) params.cuisine = cuisine;
    // default to excluding drinks unless explicitly overridden
    params.type = type || 'main course,side dish,salad,breakfast,appetizer,soup,snack,dessert';

    const response = await axios.get('https://api.spoonacular.com/recipes/complexSearch', { params });

    const results = response.data.results;
    let synced = 0;
    let skipped = 0;

    for (const item of results) {
      const existing = await Recipe.findById(item.id);
      if (existing) {
        skipped++;
        continue;
      }

      const detailRes = await axios.get(`https://api.spoonacular.com/recipes/${item.id}/information`, {
        params: { includeNutrition: true, apiKey: process.env.SPOONACULAR_API_KEY }
      });

      const raw = detailRes.data;

      // fetch step-by-step instructions
      let instructions = null;
      try {
        const instrRes = await axios.get(`https://api.spoonacular.com/recipes/${raw.id}/analyzedInstructions`, {
          params: { apiKey: process.env.SPOONACULAR_API_KEY }
        });
        const steps = instrRes.data?.[0]?.steps;
        if (steps?.length) {
          instructions = JSON.stringify(steps.map(s => s.step));
        }
      } catch (_) {}

      const recipe = {
        id: raw.id,
        title: raw.title,
        image: raw.image,
        calories: getNutrient(raw, 'Calories'),
        protein: getNutrient(raw, 'Protein'),
        fat: getNutrient(raw, 'Fat'),
        carbs: getNutrient(raw, 'Carbohydrates'),
        vegetarian: raw.vegetarian,
        vegan: raw.vegan,
        glutenFree: raw.glutenFree,
        readyInMinutes: raw.readyInMinutes,
        ingredientCount: raw.extendedIngredients?.length || 0,
        instructions,
      };

      await Recipe.upsert(recipe);

      const tags = generateTags(recipe);
      await Recipe.insertTags(recipe.id, tags);

      if (raw.extendedIngredients?.length) {
        const ingredients = raw.extendedIngredients.map(i => ({
          name: i.name,
          metric_value: i.measures?.metric?.amount ?? null,
          metric_unit: i.measures?.metric?.unitShort ?? null,
        }));
        await Recipe.insertIngredients(recipe.id, ingredients);
      }

      synced++;
    }

    res.json({ message: 'Recipes synced', synced, skipped });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.createRecipe = async (req, res) => {
  try {
    const { title, image, calories, protein, fat, carbs, vegetarian, vegan, gluten_free, ready_in_minutes, tags } = req.body;
    if (!title) return res.status(400).json({ error: 'title is required' });
    // Use a negative auto-decrement ID for manual recipes to avoid Spoonacular ID conflicts
    const { pool } = require('../../config/db');
    const [[minRow]] = await pool.query('SELECT MIN(id) as min_id FROM recipes');
    const newId = Math.min((minRow.min_id || 0) - 1, -1);
    const recipe = {
      id: newId, title, image: image || null,
      calories: calories || 0, protein: protein || 0, fat: fat || 0, carbs: carbs || 0,
      vegetarian: vegetarian || false, vegan: vegan || false, gluten_free: gluten_free || false,
      ready_in_minutes: ready_in_minutes || 0,
    };
    await Recipe.upsert(recipe);
    if (tags?.length) await Recipe.insertTags(newId, tags);
    const created = await Recipe.findById(newId);
    res.status(201).json(created);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.updateRecipe = async (req, res) => {
  try {
    const allowed = ['title', 'image', 'calories', 'protein', 'fat', 'carbs', 'vegetarian', 'vegan', 'gluten_free', 'ready_in_minutes', 'instructions'];
    const data = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));
    if (Object.keys(data).length === 0) return res.status(400).json({ error: 'No valid fields to update' });
    const { pool } = require('../../config/db');
    await pool.query('UPDATE recipes SET ? WHERE id = ?', [data, req.params.id]);
    const updated = await Recipe.findById(req.params.id);
    if (!updated) return res.status(404).json({ error: 'Recipe not found' });
    res.json(updated);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.deleteRecipe = async (req, res) => {
  try {
    const { pool } = require('../../config/db');
    const [result] = await pool.query('DELETE FROM recipes WHERE id = ?', [req.params.id]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Recipe not found' });
    res.json({ message: 'Recipe deleted' });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.getRecipes = async (req, res) => {
  try {
    const { tag } = req.query;
    const recipes = tag ? await Recipe.findByTag(tag) : await Recipe.findAll();
    res.json(recipes);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.getRecipe = async (req, res) => {
  try {
    const recipe = await Recipe.findById(req.params.id);
    if (!recipe) return res.status(404).json({ error: 'Recipe not found' });
    res.json(recipe);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};
