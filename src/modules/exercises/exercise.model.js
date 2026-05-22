const { pool } = require('../../config/db');

const KNOWN_EQUIPMENTS = ['barbell', 'dumbbell', 'cable', 'machine', 'kettlebell', 'band', 'medicine ball', 'exercise ball', 'foam roll', 'ez curl', 'pull-up bar', 'bench', 'rack', 'smith', 'sled', 'tire', 'sandbag', 'rings', 'box', 'jump rope', 'rowing'];

const Exercise = {
  async filter({ name, type, muscle, equipment, difficulty, order } = {}) {
    const conditions = [];
    const values = [];
    if (name)       { conditions.push('name LIKE ?');       values.push(`%${name}%`); }
    if (type)       { conditions.push('type = ?');          values.push(type); }
    if (muscle)     { conditions.push('muscle = ?');        values.push(muscle); }
    if (equipment) {
      if (equipment === 'other') {
        // exercises where equipment doesn't match any known value
        KNOWN_EQUIPMENTS.forEach(() => conditions.push('equipment NOT LIKE ?'));
        KNOWN_EQUIPMENTS.forEach(e => values.push(`%${e}%`));
        conditions.push('equipment != ?');
        values.push('');
      } else if (equipment === 'none') {
        conditions.push('(equipment = ? OR equipment IS NULL)');
        values.push('');
      } else {
        conditions.push('equipment LIKE ?');
        values.push(`%${equipment}%`);
      }
    }
    if (difficulty) { conditions.push('difficulty = ?');    values.push(difficulty); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const sort = order === 'desc' ? 'ORDER BY name DESC' : 'ORDER BY name ASC';
    const [rows] = await pool.query(`SELECT * FROM exercises ${where} ${sort}`, values);
    return rows;
  },
  async find(where = {}, fields = null) {
    const cols = fields ? fields.split(' ').join(', ') : '*';
    if (Object.keys(where).length === 0) {
      const [rows] = await pool.query(`SELECT ${cols} FROM exercises`);
      return rows;
    }
    const key = Object.keys(where)[0];
    const [rows] = await pool.query(`SELECT ${cols} FROM exercises WHERE ${key} = ?`, [where[key]]);
    return rows;
  },
  async findById(id) {
    const [rows] = await pool.query('SELECT * FROM exercises WHERE id = ?', [id]);
    return rows[0] || null;
  },
  async findOne(where) {
    const key = Object.keys(where)[0];
    const val = where[key] instanceof RegExp ? where[key].source.replace(/^\^/, '').replace(/\$i?$/, '') : where[key];
    const [rows] = await pool.query(`SELECT * FROM exercises WHERE ${key} = ?`, [val]);
    return rows[0] || null;
  },
  async create(data) {
    const [result] = await pool.query('INSERT INTO exercises SET ?', [data]);
    return { id: result.insertId, ...data };
  },
  async insertMany(items) {
    const results = [];
    for (const item of items) {
      const [result] = await pool.query('INSERT INTO exercises SET ?', [item]);
      results.push({ id: result.insertId, ...item });
    }
    return results;
  },
  async deleteMany() {
    await pool.query('DELETE FROM exercises');
  },
  async findByIdAndUpdate(id, data) {
    await pool.query('UPDATE exercises SET ? WHERE id = ?', [data, id]);
    return Exercise.findById(id);
  }
};

module.exports = Exercise;
