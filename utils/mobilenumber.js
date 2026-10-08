const { randomInt } = require('node:crypto');

const generatedNumbers = new Set();

function generateUniqueMobile(countryCode) {
  const normalizedCode = String(countryCode).replace(/^\+/, '').toUpperCase();
  let number;

  do {
    switch (normalizedCode) {
      case 'IN':
      case '91':
        number = `${randomInt(6, 10)}${randomDigits(9)}`;
        break;
      case 'GB':
      case '44':
        number = `7${randomDigits(9)}`;
        break;
      default:
        throw new Error(
          `Mobile number generation is not configured for country code "${countryCode}".`,
        );
    }
  } while (generatedNumbers.has(`${normalizedCode}:${number}`));

  generatedNumbers.add(`${normalizedCode}:${number}`);
  return number;
}

function randomDigits(length) {
  return Array.from({ length }, () => randomInt(0, 10)).join('');
}

module.exports = { generateUniqueMobile };
