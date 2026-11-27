// Reads EUR-Lex's own record of each adequacy decision from the Publications Office's CELLAR
// SPARQL endpoint: whether it is in force and until when, and which acts in force read as one.
// Anything the answer does not hold as expected fails as unreadable, never as fewer acts.
export const SPARQL_ENDPOINT = "https://publications.europa.eu/webapi/rdf/sparql";

export const SPARQL_RESULTS = "application/sparql-results+json";

const CDM = "PREFIX cdm: <http://publications.europa.eu/ontology/cdm#>";
const ENGLISH = "<http://publications.europa.eu/resource/authority/language/ENG>";
const CELEX = /^3\d{4}D\d{4}$/;

// The end of validity EUR-Lex gives an act that has none.
export const OPEN_END = "9999-12-31";

export interface ActStatus {
  readonly celex: string;
  readonly inForce: boolean;
  // `null` when EUR-Lex gives none, `OPEN_END` when the act has none.
  readonly endOfValidity: string | null;
}

export interface ActInForce {
  readonly celex: string;
  readonly title: string;
}

export class UnreadableSourceError extends Error {
  override readonly name = "UnreadableSourceError";
}

export interface StatusQueryFunction {
  (celexes: readonly string[]): string;
}

export interface QueryUrlFunction {
  (query: string): string;
}

export interface ReadStatusesFunction {
  (body: string): readonly ActStatus[];
}

export interface ReadActsInForceFunction {
  (body: string): readonly ActInForce[];
}

export const queryUrl: QueryUrlFunction = (query) =>
  `${SPARQL_ENDPOINT}?${new URLSearchParams({ query })}`;

export const statusQuery: StatusQueryFunction = (celexes) => {
  for (const celex of celexes) {
    if (!CELEX.test(celex)) throw new TypeError(`${celex} is no CELEX number of a decision`);
  }
  return `${CDM}
SELECT ?celex ?inForce ?end WHERE {
  ?work cdm:resource_legal_id_celex ?celex .
  FILTER(STR(?celex) IN (${celexes.map((celex) => `"${celex}"`).join(", ")}))
  OPTIONAL { ?work cdm:resource_legal_in-force ?inForce }
  OPTIONAL { ?work cdm:resource_legal_date_end-of-validity ?end }
}`;
};

// Every decision of the Commission in force whose English title speaks of adequate protection:
// broad on purpose, so that a decision the list does not hold yet, a renewal or an amendment shows.
export const ACTS_IN_FORCE_QUERY = `${CDM}
SELECT DISTINCT ?celex ?title WHERE {
  ?work cdm:resource_legal_id_celex ?celex ;
        cdm:resource_legal_in-force ?inForce .
  FILTER(STR(?inForce) IN ("1", "true"))
  FILTER(REGEX(STR(?celex), "^3[0-9]{4}D[0-9]{4}$"))
  ?expression cdm:expression_belongs_to_work ?work ;
              cdm:expression_uses_language ${ENGLISH} ;
              cdm:expression_title ?title .
  FILTER(CONTAINS(LCASE(STR(?title)), "adequa") && CONTAINS(LCASE(STR(?title)), "protection"))
}`;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const bindingsOf = (body: string, variables: readonly string[]): readonly unknown[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new UnreadableSourceError("its answer is no JSON");
  }
  const head = isRecord(parsed) ? parsed.head : undefined;
  const vars = isRecord(head) ? head.vars : undefined;
  const results = isRecord(parsed) ? parsed.results : undefined;
  const bindings = isRecord(results) ? results.bindings : undefined;
  if (!Array.isArray(vars) || !Array.isArray(bindings)) {
    throw new UnreadableSourceError("its answer holds no SPARQL results");
  }
  for (const variable of variables) {
    if (!vars.includes(variable)) {
      throw new UnreadableSourceError(`its answer has no variable ${variable}`);
    }
  }
  return bindings;
};

const termOf = (binding: unknown, variable: string): string | undefined => {
  if (!isRecord(binding))
    throw new UnreadableSourceError("its answer holds a row that is no object");
  const term = binding[variable];
  if (term === undefined) return undefined;
  const value = isRecord(term) ? term.value : undefined;
  if (typeof value !== "string") {
    throw new UnreadableSourceError(`its answer holds a ${variable} that is no literal`);
  }
  return value;
};

const required = (binding: unknown, variable: string): string => {
  const value = termOf(binding, variable);
  if (value === undefined)
    throw new UnreadableSourceError(`its answer holds a row without ${variable}`);
  return value;
};

const celexOf = (binding: unknown): string => {
  const celex = required(binding, "celex");
  if (!CELEX.test(celex)) {
    throw new UnreadableSourceError(
      `its answer holds ${JSON.stringify(celex)}, no CELEX number of a decision`,
    );
  }
  return celex;
};

const IN_FORCE: Readonly<Record<string, boolean>> = {
  "1": true,
  true: true,
  "0": false,
  false: false,
};

const inForceOf = (celex: string, value: string | undefined): boolean => {
  if (value === undefined)
    throw new UnreadableSourceError(`it says nothing of whether ${celex} is in force`);
  const inForce = IN_FORCE[value];
  if (inForce === undefined) {
    throw new UnreadableSourceError(
      `it says ${celex} is in force ${JSON.stringify(value)}, neither true nor false`,
    );
  }
  return inForce;
};

const dateOf = (celex: string, value: string | undefined): string | null => {
  if (value === undefined) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new UnreadableSourceError(
      `it ends the validity of ${celex} on ${JSON.stringify(value)}, no date`,
    );
  }
  return value;
};

// A work EUR-Lex records twice must say the same each time: two statuses could hide a repeal.
export const readStatuses: ReadStatusesFunction = (body) => {
  const statuses = new Map<string, ActStatus>();
  for (const binding of bindingsOf(body, ["celex", "inForce", "end"])) {
    const celex = celexOf(binding);
    const status: ActStatus = {
      celex,
      inForce: inForceOf(celex, termOf(binding, "inForce")),
      endOfValidity: dateOf(celex, termOf(binding, "end")),
    };
    const known = statuses.get(celex);
    if (
      known !== undefined &&
      (known.inForce !== status.inForce || known.endOfValidity !== status.endOfValidity)
    ) {
      throw new UnreadableSourceError(`it gives ${celex} two statuses`);
    }
    statuses.set(celex, status);
  }
  return [...statuses.values()];
};

export const readActsInForce: ReadActsInForceFunction = (body) => {
  const acts = new Map<string, ActInForce>();
  for (const binding of bindingsOf(body, ["celex", "title"])) {
    const celex = celexOf(binding);
    const title = required(binding, "title").replace(/\s+/g, " ").trim();
    if (!acts.has(celex)) acts.set(celex, { celex, title });
  }
  if (acts.size === 0)
    throw new UnreadableSourceError("it finds no act in force that reads as an adequacy decision");
  return [...acts.values()];
};
