import type { ToolDescriptor } from '../types.js';
import type { Db } from '../../db.js';
import { toMarkdownTable } from '../../sql/markdown.js';

export function diskIoLatencyTool(db: Db): ToolDescriptor {
  return {
    name: 'mssql_disk_io_latency',
    title: 'Get Disk I/O Latency',
    description:
      'Disk I/O latency per database file: reads, writes, average read and write stall (ms) and a rating from Exceptional to Critical. Use to find slow storage.',
    inputSchema: {},
    handler: async () => {
      const query = `
SELECT
  DB_NAME(vfs.database_id)                                          AS [Database],
  mf.[name]                                                         AS [Logical File],
  vfs.num_of_reads                                                  AS [Reads],
  vfs.num_of_writes                                                 AS [Writes],
  vfs.io_stall_read_ms  / NULLIF(vfs.num_of_reads,  0)             AS [Avg Read Stall ms],
  vfs.io_stall_write_ms / NULLIF(vfs.num_of_writes, 0)             AS [Avg Write Stall ms],
  CASE
    WHEN (vfs.io_stall_read_ms / NULLIF(vfs.num_of_reads, 0)) <  1 THEN 'Exceptional'
    WHEN (vfs.io_stall_read_ms / NULLIF(vfs.num_of_reads, 0)) <  5 THEN 'Excellent'
    WHEN (vfs.io_stall_read_ms / NULLIF(vfs.num_of_reads, 0)) < 10 THEN 'Good'
    WHEN (vfs.io_stall_read_ms / NULLIF(vfs.num_of_reads, 0)) < 20 THEN 'Acceptable'
    WHEN (vfs.io_stall_read_ms / NULLIF(vfs.num_of_reads, 0)) < 50 THEN 'Poor'
    WHEN (vfs.io_stall_read_ms / NULLIF(vfs.num_of_reads, 0)) >= 50 THEN 'Critical'
    ELSE 'N/A'
  END AS [Health Status]
FROM sys.dm_io_virtual_file_stats(NULL, NULL) AS vfs
JOIN sys.master_files AS mf
  ON vfs.database_id = mf.database_id AND vfs.file_id = mf.file_id
WHERE vfs.database_id > 4
ORDER BY [Avg Read Stall ms] DESC;`;

      const result = await db.executeQuery<Record<string, any>>({ query });
      if (!result || result.length === 0) return 'No disk I/O latency data found.';
      return toMarkdownTable(result);
    },
  };
}
