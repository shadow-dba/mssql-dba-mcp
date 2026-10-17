import { z } from 'zod';
import type { ToolDescriptor } from '../types.js';
import type { Db } from '../../db.js';

// Plan XML can be several MB; this keeps it under the server's output cap.
const MAX_PLAN_CHARS = 35_000;

export function executionPlanTool(db: Db): ToolDescriptor {
  return {
    name: 'mssql_execution_plan',
    title: 'Get Execution Plan',
    description:
      'Execution plan (showplan XML) of a cached query, by plan handle. Reads the plan cache only; never runs the query. ' +
      'Get the Plan Handle from mssql_top_queries. Large plans are cut at ' + MAX_PLAN_CHARS.toLocaleString('en-US') + ' characters.',
    inputSchema: {
      queryPlanHandle: z
        .string()
        .describe('Hex plan handle from sys.dm_exec_query_stats (e.g. 0x060006...).'),
    },
    handler: async ({ queryPlanHandle }: { queryPlanHandle: string }) => {
      if (!/^0x[0-9A-Fa-f]+$/i.test(queryPlanHandle)) {
        throw new Error(
          'Invalid plan handle format. Expected hex string like 0x060006001234ABCD...'
        );
      }

      const query = `
SELECT query_plan
FROM sys.dm_exec_query_plan(CONVERT(varbinary(64), @planHandle, 1)) AS qp;`;

      const result = await db.executeQuery<Record<string, any>>({
        query,
        parameters: { planHandle: queryPlanHandle },
      });
      const xml = result?.[0]?.query_plan as string | null | undefined;
      if (!xml) return 'No execution plan found for this handle: it left the plan cache, or SQL Server cannot return it as XML (too deeply nested).';
      if (xml.length <= MAX_PLAN_CHARS) return '```xml\n' + xml + '\n```';
      return (
        '```xml\n' + xml.slice(0, MAX_PLAN_CHARS) + '\n```\n\n' +
        `_Plan cut: showing ${MAX_PLAN_CHARS} of ${xml.length} characters. Look at the most expensive operators first._`
      );
    },
  };
}
