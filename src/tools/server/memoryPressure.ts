import type { ToolDescriptor } from '../types.js';
import type { Db } from '../../db.js';
import { toMarkdownTable } from '../../sql/markdown.js';

export function memoryPressureTool(db: Db): ToolDescriptor {
  return {
    name: 'mssql_memory_pressure',
    title: 'Get Memory Pressure',
    description:
      'Memory pressure: Page Life Expectancy (PLE) from the Buffer Manager. PLE below 300 signals memory pressure; below 1000 on modern servers is worth a look.',
    inputSchema: {},
    handler: async () => {
      const query = `
SELECT
  object_name,
  counter_name,
  cntr_value
FROM sys.dm_os_performance_counters
WHERE counter_name = 'Page life expectancy'
  AND object_name LIKE '%Buffer Manager%';`;

      const result = await db.executeQuery<Record<string, any>>({ query });
      if (!result || result.length === 0) return 'No memory pressure metrics found.';
      return toMarkdownTable(result);
    },
  };
}
