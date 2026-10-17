import type { ZodRawShape } from 'zod';

export interface ToolDescriptor {
  /** `mssql_` prefix + snake_case. Renaming a tool breaks users, so keep names stable. */
  name: string;
  title: string;
  /** Search keywords first: clients that defer tools match only the start of the text. */
  description: string;
  inputSchema: ZodRawShape;
  /** Load the tool's schema at session start instead of on demand. Keep this to 3-5 tools. */
  alwaysLoad?: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (args: any) => Promise<string>;
}
