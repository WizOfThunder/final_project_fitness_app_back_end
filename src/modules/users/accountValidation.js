const ACCOUNT_LIMITS = {
  minNameLetters: 3,
  minPasswordLength: 6,
  minPhoneDigits: 8,
  maxPhoneDigits: 15,
  minProfessionLength: 3,
  minExperienceYears: 1,
  maxExperienceYears: 80,
};

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_REGEX = /^\+?[\d\s\-()]+$/;
const HTTP_URL_REGEX = /^https?:\/\/\S+$/i;
const UPLOAD_PATH_REGEX = /^\/uploads\/\S+/i;

function normalizeValue(value) {
  return String(value ?? '').trim();
}

function normalizeOptionalText(value) {
  if (value === undefined) {
    return undefined;
  }

  const normalizedValue = normalizeValue(value);
  return normalizedValue ? normalizedValue : null;
}

function normalizeEmail(value) {
  return normalizeValue(value).toLowerCase();
}

function countLetters(value) {
  return (value.match(/[A-Za-z]/g) || []).length;
}

function validateName(value, { required = true } = {}) {
  const normalizedValue = normalizeValue(value);

  if (!normalizedValue) {
    return required ? 'Name is required.' : null;
  }

  if (
    normalizedValue.length < ACCOUNT_LIMITS.minNameLetters ||
    countLetters(normalizedValue) < ACCOUNT_LIMITS.minNameLetters
  ) {
    return `Name must include at least ${ACCOUNT_LIMITS.minNameLetters} letters.`;
  }

  return null;
}

function validateEmail(value, { required = true } = {}) {
  const normalizedValue = normalizeEmail(value);

  if (!normalizedValue) {
    return required ? 'Email is required.' : null;
  }

  if (!EMAIL_REGEX.test(normalizedValue)) {
    return 'Enter a valid email address.';
  }

  return null;
}

function validatePassword(value, { required = true } = {}) {
  const normalizedValue = String(value ?? '');

  if (!normalizedValue) {
    return required ? 'Password is required.' : null;
  }

  if (normalizedValue.length < ACCOUNT_LIMITS.minPasswordLength) {
    return `Password must be at least ${ACCOUNT_LIMITS.minPasswordLength} characters.`;
  }

  return null;
}

function validatePhoneNumber(value, { required = true } = {}) {
  const normalizedValue = normalizeValue(value);

  if (!normalizedValue) {
    return required ? 'Phone number is required.' : null;
  }

  if (!PHONE_REGEX.test(normalizedValue)) {
    return 'Phone number can only contain digits, spaces, parentheses, dashes, and an optional leading +.';
  }

  const digitCount = normalizedValue.replace(/\D/g, '').length;
  if (
    digitCount < ACCOUNT_LIMITS.minPhoneDigits ||
    digitCount > ACCOUNT_LIMITS.maxPhoneDigits
  ) {
    return `Phone number must contain ${ACCOUNT_LIMITS.minPhoneDigits} to ${ACCOUNT_LIMITS.maxPhoneDigits} digits.`;
  }

  return null;
}

function validateProfession(value, { required = false } = {}) {
  const normalizedValue = normalizeValue(value);

  if (!normalizedValue) {
    return required ? 'Profession is required.' : null;
  }

  if (normalizedValue.length < ACCOUNT_LIMITS.minProfessionLength) {
    return `Profession must be at least ${ACCOUNT_LIMITS.minProfessionLength} characters.`;
  }

  return null;
}

function validateExperienceYears(value, { required = false } = {}) {
  const normalizedValue = normalizeValue(value);

  if (!normalizedValue) {
    return required ? 'Experience is required.' : null;
  }

  const years = Number(normalizedValue);
  if (!Number.isInteger(years)) {
    return 'Experience must be a whole number.';
  }

  if (
    years < ACCOUNT_LIMITS.minExperienceYears ||
    years > ACCOUNT_LIMITS.maxExperienceYears
  ) {
    return `Experience must be between ${ACCOUNT_LIMITS.minExperienceYears} and ${ACCOUNT_LIMITS.maxExperienceYears} years.`;
  }

  return null;
}

function validateCertificationUrl(value, { required = false, hasCertificationFile = false } = {}) {
  const normalizedValue = normalizeValue(value);

  if (!normalizedValue) {
    return required && !hasCertificationFile
      ? 'Upload a certification file or provide a certification URL.'
      : null;
  }

  if (!HTTP_URL_REGEX.test(normalizedValue) && !UPLOAD_PATH_REGEX.test(normalizedValue)) {
    return 'Certification URL must start with http:// or https://.';
  }

  return null;
}

function validateRegistrationFields({
  name,
  email,
  password,
  phone_number,
  role,
  profession,
  experience_years,
  certification,
  certification_url,
}) {
  const baseError =
    validateName(name) ||
    validateEmail(email) ||
    validatePassword(password) ||
    validatePhoneNumber(phone_number);

  if (baseError) {
    return baseError;
  }

  if (role === 'trainer') {
    return (
      validateProfession(profession, { required: true }) ||
      validateExperienceYears(experience_years, { required: true }) ||
      validateCertificationUrl(certification_url, {
        required: true,
        hasCertificationFile: Boolean(normalizeOptionalText(certification)),
      })
    );
  }

  return null;
}

function validateProfileUpdateFields({
  name,
  email,
  phone_number,
  current_phone_number,
  role,
  profession,
  experience_years,
}) {
  if (name !== undefined) {
    const error = validateName(name);
    if (error) {
      return error;
    }
  }

  if (email !== undefined) {
    const error = validateEmail(email);
    if (error) {
      return error;
    }
  }

  const phoneRequired = role === 'member' || role === 'trainer';
  const effectivePhoneNumber =
    phone_number !== undefined ? phone_number : current_phone_number;
  const phoneError = validatePhoneNumber(effectivePhoneNumber, {
    required: phoneRequired,
  });
  if (phoneError) {
    return phoneError;
  }

  if (role === 'trainer') {
    if (profession !== undefined) {
      const error = validateProfession(profession, { required: false });
      if (error) {
        return error;
      }
    }

    if (experience_years !== undefined) {
      const error = validateExperienceYears(experience_years, { required: false });
      if (error) {
        return error;
      }
    }
  }

  return null;
}

module.exports = {
  ACCOUNT_LIMITS,
  normalizeEmail,
  normalizeOptionalText,
  validateRegistrationFields,
  validateProfileUpdateFields,
};
