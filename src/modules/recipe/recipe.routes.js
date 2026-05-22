const express = require('express');
const router = express.Router();
const recipeController = require('./recipe.controller');
const authMiddleware = require('../../middleware/auth.middleware');
const roleMiddleware = require('../../middleware/role.middleware');

router.post('/sync', authMiddleware, roleMiddleware('admin'), recipeController.syncRecipes);
router.post('/', authMiddleware, roleMiddleware('admin'), recipeController.createRecipe);
router.get('/', authMiddleware, recipeController.getRecipes);
router.get('/:id', authMiddleware, recipeController.getRecipe);
router.put('/:id', authMiddleware, roleMiddleware('admin'), recipeController.updateRecipe);
router.delete('/:id', authMiddleware, roleMiddleware('admin'), recipeController.deleteRecipe);

module.exports = router;
