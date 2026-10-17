import type { ToolDescriptor } from '../types.js';
import type { Db } from '../../db.js';
import { toMarkdownTable } from '../../sql/markdown.js';

export function bufferHitRatioTool(db: Db): ToolDescriptor {
  return {
    name: 'mssql_buffer_hit_ratio',
    title: 'Get Buffer Cache Hit Ratio',
    description:
      'Buffer cache hit ratio (%). Below 95% suggests too little memory for the workload.',
    inputSchema: {},
    handler: async () => {
      const query = `
SELECT
  CAST((a.cntr_value * 1.0 / b.cntr_value) * 100.0 AS DECIMAL(5,2)) AS [Buffer Cache Hit Ratio %]
FROM sys.dm_os_performance_counters a
JOIN (
  SELECT cntr_value, object_name
  FROM sys.dm_os_performance_counters
  WHERE counter_name = 'Buffer cache hit ratio base'
) b ON a.object_name = b.object_name
WHERE a.counter_name = 'Buffer cache hit ratio'
  AND a.object_name LIKE '%Buffer Manager%';`;

      const result = await db.executeQuery<Record<string, any>>({ query });
      if (!result || result.length === 0) return 'No buffer cache hit ratio found.';
      return toMarkdownTable(result);
    },
  };
}
