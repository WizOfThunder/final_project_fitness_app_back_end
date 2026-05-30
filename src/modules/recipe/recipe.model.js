const { pool } = require('../../config/db');

const ensureRecipeSchemaPromise = pool
  .query('ALTER TABLE recipes ADD COLUMN IF NOT EXISTS cuisine VARCHAR(100)')
  .catch(() => {});

async function ensureRecipeSchema() {
  await ensureRecipeSchemaPromise;
}

const Recipe = {
  async findAll() {
    await ensureRecipeSchema();
    const [rows] = await pool.query('SELECT * FROM recipes ORDER BY title ASC');
    if (!rows.length) return [];
    const ids = rows.map(r => r.id);
    const [tags] = await pool.query(
      `SELECT recipe_id, tag FROM recipe_tags WHERE recipe_id IN (${ids.map(() => '?').join(',')})`,
      ids
    );
    const tagMap = {};
    tags.forEach(t => {
      if (!tagMap[t.recipe_id]) tagMap[t.recipe_id] = [];
      tagMap[t.recipe_id].push(t.tag);
    });
    const [ingredients] = await pool.query(
      `SELECT recipe_id, name, metric_value, metric_unit FROM ingredients WHERE recipe_id IN (${ids.map(() => '?').join(',')})`,
      ids,
    );
    const ingredientMap = {};
    ingredients.forEach(i => {
      if (!ingredientMap[i.recipe_id]) ingredientMap[i.recipe_id] = [];
      ingredientMap[i.recipe_id].push({
        name: i.name,
        metric_value: i.metric_value,
        metric_unit: i.metric_unit,
      });
    });
    return rows.map(r => ({
      ...r,
      tags: tagMap[r.id] || [],
      ingredients: ingredientMap[r.id] || [],
    }));
  },

  async findById(id) {
    await ensureRecipeSchema();
    const [rows] = await pool.query('SELECT * FROM recipes WHERE id = ?', [id]);
    if (!rows[0]) return null;
    const [tags] = await pool.query('SELECT tag FROM recipe_tags WHERE recipe_id = ?', [id]);
    const [ingredients] = await pool.query(
      'SELECT name, metric_value, metric_unit FROM ingredients WHERE recipe_id = ?', [id]
    );
    return {
      ...rows[0],
      tags: tags.map(t => t.tag),
      ingredients: ingredients.map(i => ({
        name: i.name,
        metric_value: i.metric_value,
        metric_unit: i.metric_unit,
      }))
    };
  },

  async findByTag(tag) {
    await ensureRecipeSchema();
    const [rows] = await pool.query(
      `SELECT r.* FROM recipes r
       JOIN recipe_tags rt ON rt.recipe_id = r.id
       WHERE rt.tag = ?`,
      [tag]
    );
    return rows;
  },

  async upsert(recipe) {
    await ensureRecipeSchema();
    await pool.query(
      `INSERT INTO recipes (id, title, image, calories, protein, fat, carbs, vegetarian, vegan, gluten_free, ready_in_minutes, instructions, cuisine)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET
          title = EXCLUDED.title,
          image = EXCLUDED.image,
         calories = EXCLUDED.calories,
         protein = EXCLUDED.protein,
         fat = EXCLUDED.fat,
          carbs = EXCLUDED.carbs,
          vegetarian = EXCLUDED.vegetarian,
          vegan = EXCLUDED.vegan,
          gluten_free = EXCLUDED.gluten_free,
          ready_in_minutes = EXCLUDED.ready_in_minutes,
          instructions = EXCLUDED.instructions,
          cuisine = EXCLUDED.cuisine`,
       [recipe.id, recipe.title, recipe.image, recipe.calories, recipe.protein,
        recipe.fat, recipe.carbs, recipe.vegetarian, recipe.vegan, recipe.glutenFree ?? recipe.gluten_free, recipe.readyInMinutes ?? recipe.ready_in_minutes, recipe.instructions ?? null, recipe.cuisine ?? null]
    );
  },

  async updateCuisine(recipeId, cuisine) {
    await ensureRecipeSchema();
    await pool.query('UPDATE recipes SET cuisine = ? WHERE id = ?', [
      cuisine,
      recipeId,
    ]);
  },

  async insertTags(recipeId, tags) {
    await ensureRecipeSchema();
    await pool.query('DELETE FROM recipe_tags WHERE recipe_id = ?', [recipeId]);
    for (const tag of tags) {
      await pool.query('INSERT INTO recipe_tags (recipe_id, tag) VALUES (?, ?)', [recipeId, tag]);
    }
  },

  async insertIngredients(recipeId, ingredients) {
    await ensureRecipeSchema();
    await pool.query('DELETE FROM ingredients WHERE recipe_id = ?', [recipeId]);
    for (const ing of ingredients) {
      await pool.query(
        'INSERT INTO ingredients (recipe_id, name, metric_value, metric_unit) VALUES (?, ?, ?, ?)',
        [recipeId, ing.name, ing.metric_value ?? null, ing.metric_unit ?? null]
      );
    }
  }
};

module.exports = Recipe;
