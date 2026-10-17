import type { Db } from '../db.js';
import type { ToolDescriptor } from './types.js';

import { serverVersionTool } from './server/serverVersion.js';
import { serverTimezoneTool } from './server/serverTimezone.js';
import { memoryPressureTool } from './server/memoryPressure.js';
import { bufferHitRatioTool } from './server/bufferHitRatio.js';
import { diskIoLatencyTool } from './server/diskIoLatency.js';
import { executionPlanTool } from './server/executionPlan.js';
import { blockingTool } from './server/blocking.js';
import { recentBackupsTool } from './server/recentBackups.js';
import { allDbInfoTool } from './server/allDbInfo.js';
import { storageCapacityTool } from './server/storageCapacity.js';
import { offlineDbTool } from './server/offlineDb.js';
import { agentJobsTool } from './server/agentJobs.js';
import { agentFailedJobsTool } from './server/agentFailedJobs.js';
import { topQueriesTool } from './server/topQueries.js';
import { waitStatsTool } from './server/waitStats.js';
import { runningRequestsTool } from './server/runningRequests.js';
import { serverConfigTool } from './server/serverConfig.js';
import { tempdbHealthTool } from './server/tempdbHealth.js';
import { checkdbStatusTool } from './server/checkdbStatus.js';
import { errorLogTool } from './server/errorLog.js';
import { privilegedLoginsTool } from './server/privilegedLogins.js';
import { dbOwnersTool } from './server/dbOwners.js';
import { agentAlertsTool } from './server/agentAlerts.js';
import { vlfCountsTool } from './server/vlfCounts.js';
import { autogrowthIssuesTool } from './server/autogrowthIssues.js';
import { dbConfigHealthTool } from './server/dbConfigHealth.js';

import { dbInfoTool } from './database/dbInfo.js';
import { dbCollationTool } from './database/dbCollation.js';
import { dbCollationMismatchesTool } from './database/dbCollationMismatches.js';
import { dbIndexHealthTool } from './database/dbIndexHealth.js';
import { dbMissingIndexesTool } from './database/dbMissingIndexes.js';
import { dbBackupHistoryTool } from './database/dbBackupHistory.js';
import { dbTablesTool } from './database/dbTables.js';
import { dbTableKeysTool } from './database/dbTableKeys.js';
import { dbCheckConstraintsTool } from './database/dbCheckConstraints.js';
import { dbIdentityHeadroomTool } from './database/dbIdentityHeadroom.js';
import { dbColumnDesignIssuesTool } from './database/dbColumnDesignIssues.js';
import { dbForeignKeysTool } from './database/dbForeignKeys.js';
import { tableInfoTool } from './database/tableInfo.js';
import { tableIndexHealthTool } from './database/tableIndexHealth.js';
import { tableMissingIndexesTool } from './database/tableMissingIndexes.js';

import { runSelectTool } from './query/runSelect.js';

/** The single tool registry. The order here is the order of `tools/list`. */
export function createTools(db: Db): ToolDescriptor[] {
  return [
    // Server
    serverVersionTool(db),
    serverTimezoneTool(db),
    waitStatsTool(db),
    topQueriesTool(db),
    executionPlanTool(db),
    runningRequestsTool(db),
    blockingTool(db),
    memoryPressureTool(db),
    bufferHitRatioTool(db),
    diskIoLatencyTool(db),
    storageCapacityTool(db),
    tempdbHealthTool(db),
    serverConfigTool(db),
    errorLogTool(db),
    allDbInfoTool(db),
    offlineDbTool(db),
    dbConfigHealthTool(db),
    dbOwnersTool(db),
    recentBackupsTool(db),
    checkdbStatusTool(db),
    vlfCountsTool(db),
    autogrowthIssuesTool(db),
    agentJobsTool(db),
    agentFailedJobsTool(db),
    agentAlertsTool(db),
    privilegedLoginsTool(db),
    // Database
    dbInfoTool(db),
    dbCollationTool(db),
    dbCollationMismatchesTool(db),
    dbTablesTool(db),
    dbIndexHealthTool(db),
    dbMissingIndexesTool(db),
    dbBackupHistoryTool(db),
    dbTableKeysTool(db),
    dbForeignKeysTool(db),
    dbCheckConstraintsTool(db),
    dbIdentityHeadroomTool(db),
    dbColumnDesignIssuesTool(db),
    tableInfoTool(db),
    tableIndexHealthTool(db),
    tableMissingIndexesTool(db),
    // Query
    runSelectTool(db),
  ];
}
