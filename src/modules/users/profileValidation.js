const PROFILE_LIMITS = {
  minAge: 10,
  maxAge: 100,
  minHeightCm: 100,
  maxHeightCm: 280,
  minWeightKg: 35,
  maxWeightKg: 350,
};

function parseDateOnly(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]) - 1;
    const day = Number(match[3]);
    const parsed = new Date(year, month, day);

    if (
      parsed.getFullYear() !== year ||
      parsed.getMonth() !== month ||
      parsed.getDate() !== day
    ) {
      return null;
    }

    return parsed;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function calculateAge(dob, today = new Date()) {
  const current = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const birthDate = new Date(dob.getFullYear(), dob.getMonth(), dob.getDate());

  let age = current.getFullYear() - birthDate.getFullYear();
  const hasHadBirthday =
    current.getMonth() > birthDate.getMonth() ||
    (current.getMonth() === birthDate.getMonth() &&
      current.getDate() >= birthDate.getDate());

  if (!hasHadBirthday) {
    age -= 1;
  }

  return age;
}

function validateNumericRange(value, {min, max, label, unit}) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const normalizedValue = Number(value);
  if (!Number.isFinite(normalizedValue)) {
    return `${label} must be a valid number.`;
  }

  if (normalizedValue < min || normalizedValue > max) {
    return `${label} must be between ${min} and ${max} ${unit}.`;
  }

  return null;
}

function validateProfileMetrics({height, weight, dob}) {
  const heightError = validateNumericRange(height, {
    min: PROFILE_LIMITS.minHeightCm,
    max: PROFILE_LIMITS.maxHeightCm,
    label: 'Height',
    unit: 'cm',
  });
  if (heightError) {
    return heightError;
  }

  const weightError = validateNumericRange(weight, {
    min: PROFILE_LIMITS.minWeightKg,
    max: PROFILE_LIMITS.maxWeightKg,
    label: 'Weight',
    unit: 'kg',
  });
  if (weightError) {
    return weightError;
  }

  if (dob !== undefined) {
    const parsedDob = parseDateOnly(dob);
    if (!parsedDob) {
      return 'Date of birth is invalid.';
    }

    const age = calculateAge(parsedDob);
    if (age < PROFILE_LIMITS.minAge || age > PROFILE_LIMITS.maxAge) {
      return `Age must be between ${PROFILE_LIMITS.minAge} and ${PROFILE_LIMITS.maxAge} years.`;
    }
  }

  return null;
}

module.exports = {
  validateProfileMetrics,
};
