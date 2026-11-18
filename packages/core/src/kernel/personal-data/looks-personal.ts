// Words that name personal data: the identifiers of article 4(1) of the GDPR (a name, an
// identification number, location data, an online identifier, physical, economic or social
// traits), the special categories of article 9 and the criminal records of article 10, and free
// text written about someone. A field is read word by word, and two words at a time, so
// `birthDate`, `birth_date` and `birthdate` all match while `rate` inside `birthRate` never does.
const TERMS: readonly string[] = [
  // Names.
  "name",
  "firstname",
  "lastname",
  "surname",
  "forename",
  "fullname",
  "givenname",
  "familyname",
  "maidenname",
  "nickname",
  "username",
  "initials",
  // Contact.
  "email",
  "mail",
  "phone",
  "mobile",
  "telephone",
  "fax",
  "address",
  "street",
  "city",
  "zip",
  "zipcode",
  "postcode",
  "postalcode",
  // Birth and age.
  "birth",
  "birthday",
  "birthdate",
  "dob",
  "age",
  // Identity documents and numbers.
  "passport",
  "ssn",
  "nif",
  "nie",
  "dni",
  "nino",
  "taxid",
  "taxnumber",
  "vatnumber",
  "nationalid",
  "idcard",
  "idnumber",
  "driverlicense",
  "licenseplate",
  // Money.
  "iban",
  "bic",
  "swift",
  "card",
  "cardnumber",
  "cvv",
  "cvc",
  "bankaccount",
  "accountnumber",
  "salary",
  "income",
  "wage",
  "creditscore",
  // Online and device identifiers.
  "ip",
  "ipaddress",
  "useragent",
  "cookie",
  "deviceid",
  "imei",
  "macaddress",
  "fingerprint",
  // Location.
  "location",
  "latitude",
  "longitude",
  "lat",
  "lng",
  "lon",
  "geo",
  "geolocation",
  "coordinates",
  "gps",
  // Physical and social traits.
  "gender",
  "sex",
  "nationality",
  "photo",
  "avatar",
  "picture",
  "selfie",
  "signature",
  "voice",
  "height",
  "weight",
  // Special categories (article 9) and criminal records (article 10) are in `SPECIAL` and
  // `CRIMINAL`, but for these two, which also name a contest and a direction.
  "race",
  "orientation",
  // Free text about someone.
  "note",
  "notes",
  "comment",
  "comments",
  "message",
  "bio",
  "biography",
];

// Words that, in the name of a field marked personal, say the data is of a special category
// (article 9), as data that reveals it indirectly is (CJEU, C-184/20), or relates to criminal
// convictions and offences (article 10). `conviction` names a belief as well as a sentence.
const SPECIAL: ReadonlySet<string> = new Set([
  "health",
  "medical",
  "diagnosis",
  "disability",
  "pregnancy",
  "allergy",
  "allergies",
  "medication",
  "genetic",
  "dna",
  "biometric",
  "ethnicity",
  "ethnic",
  "racial",
  "religion",
  "religious",
  "political",
  "tradeunion",
  "sexuality",
  "sexualorientation",
  "sexlife",
  "conviction",
]);

const CRIMINAL: ReadonlySet<string> = new Set(["criminal", "conviction", "offence", "offense"]);

const KNOWN = new Set([...TERMS, ...SPECIAL, ...CRIMINAL]);

const wordsOf = (name: string): readonly string[] =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]|(?<=[A-Za-z])(?=[0-9])|(?<=[0-9])(?=[A-Za-z])/)
    .map((word) => word.toLowerCase());

export interface LooksPersonalFunction {
  (field: string): string | null;
}

const candidatesOf = (field: string): readonly string[] => {
  const words = wordsOf(field);
  return [...words, ...words.slice(1).map((word, index) => `${words[index]}${word}`)];
};

/**
 * The word of a field's name that names personal data, `null` when none does.
 */
export const looksPersonal: LooksPersonalFunction = (field) =>
  candidatesOf(field).find((candidate) => KNOWN.has(candidate)) ?? null;

/**
 * A word of a field's name that says special categories of data or criminal data, and which of the
 * two a category must declare for it: either, for a word that says both.
 */
export interface SpecialWord {
  readonly word: string;
  readonly special: boolean;
  readonly criminal: boolean;
}

export interface LooksSpecialFunction {
  (field: string): readonly SpecialWord[];
}

/**
 * Every word of a field's name that says special categories of data or criminal data, in order.
 */
export const looksSpecial: LooksSpecialFunction = (field) =>
  candidatesOf(field)
    .filter((candidate) => SPECIAL.has(candidate) || CRIMINAL.has(candidate))
    .map((word) => ({ word, special: SPECIAL.has(word), criminal: CRIMINAL.has(word) }));
