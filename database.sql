-- Database Schema for Fitness Application

CREATE DATABASE IF NOT EXISTS fitness_app;
USE fitness_app;

-- Users Table
CREATE TABLE users (
    id INT PRIMARY KEY AUTO_INCREMENT,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    role ENUM('member', 'trainer', 'admin') DEFAULT 'member',
    height DECIMAL(5,2),
    weight DECIMAL(5,2),
    goal TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Exercises Table
CREATE TABLE exercises (
    id INT PRIMARY KEY AUTO_INCREMENT,
    name VARCHAR(255) NOT NULL,
    muscle VARCHAR(255),
    equipment VARCHAR(255),
    difficulty VARCHAR(50),
    youtube_url VARCHAR(500),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Workout Plans Table
CREATE TABLE workout_plans (
    id INT PRIMARY KEY AUTO_INCREMENT,
    user_id INT NOT NULL,
    generated_by ENUM('AI', 'trainer') NOT NULL,
    status ENUM('draft', 'verified', 'modified', 'denied') DEFAULT 'draft',
    validation_note TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Workout Plan Items Table
CREATE TABLE workout_plan_items (
    id INT PRIMARY KEY AUTO_INCREMENT,
    workout_plan_id INT NOT NULL,
    exercise_id INT NOT NULL,
    sets INT,
    reps INT,
    duration INT,
    FOREIGN KEY (workout_plan_id) REFERENCES workout_plans(id) ON DELETE CASCADE,
    FOREIGN KEY (exercise_id) REFERENCES exercises(id) ON DELETE CASCADE
);

-- Diet Plans Table
CREATE TABLE diet_plans (
    id INT PRIMARY KEY AUTO_INCREMENT,
    user_id INT NOT NULL,
    content TEXT NOT NULL,
    status ENUM('verified', 'modified', 'denied') DEFAULT 'verified',
    validation_note TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- AI Validation Logs Table
CREATE TABLE ai_validation_logs (
    id INT PRIMARY KEY AUTO_INCREMENT,
    plan_id INT NOT NULL,
    plan_type ENUM('workout', 'diet') NOT NULL,
    admin_id INT NOT NULL,
    action ENUM('verified', 'modified', 'denied') NOT NULL,
    note TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (admin_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Challenges Table
CREATE TABLE challenges (
    id INT PRIMARY KEY AUTO_INCREMENT,
    title VARCHAR(255) NOT NULL,
    type ENUM('steps', 'calories', 'distance') NOT NULL,
    target_value INT NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    created_by INT NOT NULL,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
);

-- User Challenges Table
CREATE TABLE user_challenges (
    id INT PRIMARY KEY AUTO_INCREMENT,
    user_id INT NOT NULL,
    challenge_id INT NOT NULL,
    current_value INT DEFAULT 0,
    status ENUM('active', 'completed') DEFAULT 'active',
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (challenge_id) REFERENCES challenges(id) ON DELETE CASCADE
);

-- Achievements Table
CREATE TABLE achievements (
    id INT PRIMARY KEY AUTO_INCREMENT,
    title VARCHAR(255) NOT NULL,
    description TEXT,
    rule_type ENUM('challenge_complete', 'streak', 'steps_total') NOT NULL,
    rule_value INT NOT NULL
);

-- User Achievements Table
CREATE TABLE user_achievements (
    id INT PRIMARY KEY AUTO_INCREMENT,
    user_id INT NOT NULL,
    achievement_id INT NOT NULL,
    earned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (achievement_id) REFERENCES achievements(id) ON DELETE CASCADE
);

-- Activity Logs Table (Google Fit data)
CREATE TABLE activity_logs (
    id INT PRIMARY KEY AUTO_INCREMENT,
    user_id INT NOT NULL,
    date DATE NOT NULL,
    steps INT DEFAULT 0,
    calories INT DEFAULT 0,
    distance DECIMAL(10,2) DEFAULT 0,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Indexes for better performance
CREATE INDEX idx_user_email ON users(email);
CREATE INDEX idx_workout_user ON workout_plans(user_id);
CREATE INDEX idx_diet_user ON diet_plans(user_id);
CREATE INDEX idx_activity_user_date ON activity_logs(user_id, date);
CREATE INDEX idx_user_challenges ON user_challenges(user_id, challenge_id);
