/**
 * Validates SQL Server identifiers to prevent SQL injection attacks
 * Checks for common SQL injection patterns and enforces SQL Server naming conventions
 */

const SQL_INJECTION_PATTERNS = [
  /(\bOR\b|\bAND\b).*[=<>]/i, // OR/AND with comparisons
  /;.*(--)/, // Semicolon followed by comments
  /(\/\*|\*\/)/, // Block comments
  /(\bEXEC\b|\bEXECUTE\b)/i, // Execute statements
  /(\bDROP\b|\bDELETE\b|\bTRUNCATE\b|\bALTER\b)/i, // Dangerous DDL/DML
  /xp_/i, // Extended stored procedures
  /sp_executesql/i, // Dynamic SQL execution
  /(UNION.*SELECT)/i, // Union-based injection
  /('|")\s*(OR|AND)\s*('|")/i, // Quote-based injection
  /--/, // SQL comments
  /\/\*/, // Multi-line comment start
  /\*\//, // Multi-line comment end
  /(\bINTO\b\s+\bOUTFILE\b)/i, // File operations
  /(\bLOAD_FILE\b)/i, // File reading
  /0x[0-9a-f]+/i, // Hex-encoded strings (often used in injections)
];

/**
 * Validates a single SQL Server identifier (database name, table name, column name, etc.)
 * @param identifier - The identifier to validate
 * @param parameterName - The name of the parameter being validated (for error messages)
 * @throws Error if the identifier contains SQL injection patterns or is invalid
 */
export function validateSqlIdentifier(
  identifier: string,
  parameterName: string = 'identifier'
): void {
  if (!identifier || typeof identifier !== 'string') {
    throw new Error(`${parameterName} must be a non-empty string`);
  }

  // Trim whitespace
  const trimmed = identifier.trim();

  if (trimmed.length === 0) {
    throw new Error(`${parameterName} cannot be empty or whitespace`);
  }

  // Check for SQL injection patterns
  for (const pattern of SQL_INJECTION_PATTERNS) {
    if (pattern.test(trimmed)) {
      throw new Error(
        `${parameterName} contains potentially malicious content: "${identifier}"`
      );
    }
  }

  // SQL Server identifier rules:
  // - First character must be: letter (a-z, A-Z), underscore (_), at sign (@), or number sign (#)
  // - Subsequent characters can be: letters, decimal numbers, @, $, #, or _
  // - Cannot be a reserved keyword (we'll check a subset of critical ones)
  // - Max length 128 characters for most identifiers

  // Allow for schema-qualified names (schema.object) and bracketed identifiers [name]
  const isBracketed = trimmed.startsWith('[') && trimmed.endsWith(']');

  if (isBracketed) {
    // Bracketed identifiers can contain almost anything except closing bracket
    const innerContent = trimmed.slice(1, -1);
    if (innerContent.includes(']')) {
      throw new Error(
        `${parameterName} contains invalid bracketed identifier: "${identifier}"`
      );
    }
    return; // Bracketed identifiers are considered safe if they don't contain ]
  }

  // Check for schema-qualified names
  const parts = trimmed.split('.');
  if (parts.length > 3) {
    throw new Error(
      `${parameterName} has too many parts (server.database.schema.object): "${identifier}"`
    );
  }

  // Validate each part
  for (const part of parts) {
    if (part.length === 0) {
      throw new Error(
        `${parameterName} contains empty part in qualified name: "${identifier}"`
      );
    }

    if (part.length > 128) {
      throw new Error(
        `${parameterName} part exceeds maximum length of 128 characters: "${part}"`
      );
    }

    // Check if it's a bracketed part
    if (part.startsWith('[') && part.endsWith(']')) {
      const innerContent = part.slice(1, -1);
      if (innerContent.includes(']')) {
        throw new Error(
          `${parameterName} contains invalid bracketed identifier part: "${part}"`
        );
      }
      continue;
    }

    // For non-bracketed identifiers, validate characters
    // First character: letter, _, @, or #
    if (!/^[a-zA-Z_@#]/.test(part)) {
      throw new Error(
        `${parameterName} part must start with a letter, underscore, @, or #: "${part}"`
      );
    }

    // Subsequent characters: letters, digits, @, $, #, or _
    if (!/^[a-zA-Z_@#][a-zA-Z0-9_@#$]*$/.test(part)) {
      throw new Error(
        `${parameterName} part contains invalid characters: "${part}"`
      );
    }
  }

  // Check against critical reserved keywords (non-exhaustive list)
  const CRITICAL_KEYWORDS = [
    'SELECT',
    'INSERT',
    'UPDATE',
    'DELETE',
    'DROP',
    'CREATE',
    'ALTER',
    'EXEC',
    'EXECUTE',
    'UNION',
    'FROM',
    'WHERE',
  ];

  const upperIdentifier = trimmed.toUpperCase();
  if (CRITICAL_KEYWORDS.includes(upperIdentifier)) {
    throw new Error(
      `${parameterName} cannot be a SQL reserved keyword: "${identifier}"`
    );
  }
}

/**
 * Validates an array of SQL Server identifiers
 * @param identifiers - Array of identifiers to validate
 * @param parameterName - The name of the parameter being validated (for error messages)
 * @throws Error if any identifier is invalid
 */
export function validateSqlIdentifiers(
  identifiers: string[],
  parameterName: string = 'identifiers'
): void {
  if (!Array.isArray(identifiers)) {
    throw new Error(`${parameterName} must be an array`);
  }

  if (identifiers.length === 0) {
    throw new Error(`${parameterName} array cannot be empty`);
  }

  identifiers.forEach((identifier, index) => {
    validateSqlIdentifier(identifier, `${parameterName}[${index}]`);
  });
}

/**
 * Sanitizes a SQL Server identifier by wrapping it in brackets if needed
 * This should be used after validation to safely use the identifier in queries
 * @param identifier - The validated identifier
 * @returns The bracketed identifier
 */
export function sanitizeSqlIdentifier(identifier: string): string {
  const trimmed = identifier.trim();

  // If already bracketed, return as-is
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed;
  }

  // Handle schema-qualified names
  if (trimmed.includes('.')) {
    const parts = trimmed.split('.');
    return parts
      .map((part) => {
        if (part.startsWith('[') && part.endsWith(']')) {
          return part;
        }
        return `[${part}]`;
      })
      .join('.');
  }

  // Wrap in brackets
  return `[${trimmed}]`;
}

/**
 * Validates a database name. Tools never put it raw into SQL: it is bound as a
 * parameter or passed as an N'' literal and wrapped with QUOTENAME (see
 * runInDatabaseSql). So any real SQL Server name is allowed, including ones
 * that start with a digit or contain spaces or hyphens ("2024-Sales").
 * @throws Error if the name is empty, longer than 128 characters or has control characters
 */
export function validateDatabaseName(name: string, parameterName: string = 'databaseName'): void {
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    throw new Error(`${parameterName} must be a non-empty string`);
  }
  const bare = name.trim().replace(/^\[(.*)\]$/, '$1');
  if (bare.length === 0 || bare.length > 128) {
    throw new Error(`${parameterName} must be 1 to 128 characters: "${name}"`);
  }
  if (/[\u0000-\u001f\u007f]/.test(bare)) {
    throw new Error(`${parameterName} contains control characters`);
  }
}
