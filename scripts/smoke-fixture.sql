-- Small StackOverflow-shaped database for the smoke test (CI job "smoke").
-- Run by scripts/setup-smoke-db.mjs as sa, on one connection, split on GO.
-- $(DbName) is replaced by the setup script. Not shipped in the npm package.
-- It gives every tool something real to read: a heap, an untrusted foreign key,
-- a duplicate index, missing-index suggestions, cached plans, a backup and an Agent job.

USE [master];
GO
-- Never replace a real database: stop if the name is taken (drop it with --drop first).
IF DB_ID(N'$(DbName)') IS NOT NULL
  THROW 50000, N'Database $(DbName) already exists. Use another SMOKE_DB, or run setup-smoke-db.mjs --drop.', 1;
GO
CREATE DATABASE [$(DbName)];
GO
USE [$(DbName)];
GO
CREATE SCHEMA lab;
GO
-- Marks the database as made by this fixture: setup-smoke-db.mjs --drop removes only marked ones.
EXEC sys.sp_addextendedproperty @name = N'smoke_fixture', @value = N'1';
GO

CREATE TABLE dbo.Users (
  Id             INT IDENTITY(1, 1) NOT NULL CONSTRAINT PK_Users_Id PRIMARY KEY CLUSTERED,
  AboutMe        NVARCHAR(MAX) NULL,
  Age            INT NULL,
  CreationDate   DATETIME NOT NULL,
  DisplayName    NVARCHAR(40) NOT NULL,
  DownVotes      INT NOT NULL,
  EmailHash      NVARCHAR(40) NULL,
  LastAccessDate DATETIME NOT NULL,
  Location       NVARCHAR(100) NULL,
  Reputation     INT NOT NULL,
  UpVotes        INT NOT NULL,
  Views          INT NOT NULL,
  WebsiteUrl     NVARCHAR(200) NULL,
  AccountId      INT NULL
);

CREATE TABLE dbo.Posts (
  Id                    INT IDENTITY(1, 1) NOT NULL CONSTRAINT PK_Posts_Id PRIMARY KEY CLUSTERED,
  AcceptedAnswerId      INT NULL,
  AnswerCount           INT NULL,
  Body                  NVARCHAR(MAX) NOT NULL,
  ClosedDate            DATETIME NULL,
  CommentCount          INT NULL,
  CommunityOwnedDate    DATETIME NULL,
  CreationDate          DATETIME NOT NULL,
  FavoriteCount         INT NULL,
  LastActivityDate      DATETIME NOT NULL,
  LastEditDate          DATETIME NULL,
  LastEditorDisplayName NVARCHAR(40) NULL,
  LastEditorUserId      INT NULL,
  OwnerUserId           INT NULL,
  ParentId              INT NULL,
  PostTypeId            INT NOT NULL,
  Score                 INT NOT NULL,
  Tags                  NVARCHAR(150) NULL,
  Title                 NVARCHAR(250) NULL,
  ViewCount             INT NOT NULL
);

CREATE TABLE dbo.Votes (
  Id           INT IDENTITY(1, 1) NOT NULL CONSTRAINT PK_Votes_Id PRIMARY KEY CLUSTERED,
  PostId       INT NOT NULL,
  UserId       INT NULL,
  BountyAmount INT NULL,
  VoteTypeId   INT NOT NULL,
  CreationDate DATETIME NOT NULL
);

CREATE TABLE dbo.Badges (
  Id     INT IDENTITY(1, 1) NOT NULL CONSTRAINT PK_Badges_Id PRIMARY KEY CLUSTERED,
  Name   NVARCHAR(40) NOT NULL,
  UserId INT NOT NULL,
  Date   DATETIME NOT NULL
);

CREATE TABLE dbo.Comments (
  Id           INT IDENTITY(1, 1) NOT NULL CONSTRAINT PK_Comments_Id PRIMARY KEY CLUSTERED,
  CreationDate DATETIME NOT NULL,
  PostId       INT NOT NULL,
  Score        INT NULL,
  Text         NVARCHAR(700) NOT NULL,
  UserId       INT NULL
);

CREATE TABLE dbo.Tags (
  Id            INT IDENTITY(1, 1) NOT NULL CONSTRAINT PK_Tags_Id PRIMARY KEY CLUSTERED,
  TagName       NVARCHAR(150) NOT NULL,
  Count         INT NOT NULL,
  ExcerptPostId INT NULL,
  WikiPostId    INT NULL
);

-- A heap on purpose: no primary key, no clustered index.
CREATE TABLE dbo.PostLinks (
  Id            INT NOT NULL,
  CreationDate  DATETIME NOT NULL,
  PostId        INT NOT NULL,
  RelatedPostId INT NOT NULL,
  LinkTypeId    INT NOT NULL
);

CREATE TABLE lab.Run (
  Id         INT IDENTITY(1, 1) NOT NULL CONSTRAINT PK_Run_Id PRIMARY KEY CLUSTERED,
  Name       NVARCHAR(100) NOT NULL,
  StartedAt  DATETIME2(0) NOT NULL,
  FinishedAt DATETIME2(0) NULL
);

CREATE TABLE lab.History (
  Id         BIGINT IDENTITY(1, 1) NOT NULL CONSTRAINT PK_History_Id PRIMARY KEY CLUSTERED,
  RunId      INT NOT NULL CONSTRAINT FK_History_Run FOREIGN KEY REFERENCES lab.Run (Id),
  CapturedAt DATETIME2(0) NOT NULL,
  Metric     NVARCHAR(50) NOT NULL,
  Value      DECIMAL(18, 2) NOT NULL
);
GO

-- Rows: numbers 1..5000 from a cross join of catalog views.
WITH n AS (SELECT TOP (5000) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS i
           FROM sys.all_columns a CROSS JOIN sys.all_columns b)
INSERT dbo.Users (CreationDate, DisplayName, DownVotes, LastAccessDate, Location, Reputation, UpVotes, Views, AccountId)
SELECT DATEADD(DAY, -i, '2010-12-31'), CONCAT(N'user', i), i % 7, DATEADD(DAY, i % 30, '2011-01-01'),
       CHOOSE(i % 4 + 1, N'London', N'Berlin', N'New York', NULL), (i * 37) % 20000 + 1, i % 90, i % 400, i
FROM n WHERE i <= 1000;

-- 1000 questions, then 2000 answers to them.
WITH n AS (SELECT TOP (5000) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS i
           FROM sys.all_columns a CROSS JOIN sys.all_columns b)
INSERT dbo.Posts (AnswerCount, Body, CommentCount, CreationDate, LastActivityDate, OwnerUserId, ParentId,
                  PostTypeId, Score, Tags, Title, ViewCount)
SELECT CASE WHEN i <= 1000 THEN 2 END, CONCAT(N'<p>Body of post ', i, N'</p>'), i % 5,
       DATEADD(MINUTE, i * 13, '2009-01-01'), DATEADD(MINUTE, i * 17, '2009-02-01'), i % 1000 + 1,
       CASE WHEN i > 1000 THEN (i - 1001) % 1000 + 1 END, CASE WHEN i <= 1000 THEN 1 ELSE 2 END,
       (i * 7) % 50 - 5, CASE WHEN i <= 1000 THEN CHOOSE(i % 3 + 1, N'<sql-server>', N'<t-sql><indexing>', N'<performance>') END,
       CASE WHEN i <= 1000 THEN CONCAT(N'Question ', i) END, (i * 11) % 5000
FROM n WHERE i <= 3000;

WITH n AS (SELECT TOP (5000) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS i
           FROM sys.all_columns a CROSS JOIN sys.all_columns b)
INSERT dbo.Votes (PostId, UserId, VoteTypeId, CreationDate)
SELECT i % 3000 + 1, i % 1000 + 1, CHOOSE(i % 4 + 1, 2, 2, 3, 1), DATEADD(HOUR, i, '2009-03-01')
FROM n;

WITH n AS (SELECT TOP (5000) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS i
           FROM sys.all_columns a CROSS JOIN sys.all_columns b)
INSERT dbo.Comments (CreationDate, PostId, Score, Text, UserId)
SELECT DATEADD(HOUR, i, '2009-03-01'), i % 3000 + 1, i % 4, CONCAT(N'Comment ', i), i % 1000 + 1
FROM n WHERE i <= 2000;

WITH n AS (SELECT TOP (5000) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS i
           FROM sys.all_columns a CROSS JOIN sys.all_columns b)
INSERT dbo.Badges (Name, UserId, Date)
SELECT CHOOSE(i % 4 + 1, N'Teacher', N'Student', N'Editor', N'Supporter'), i % 1000 + 1, DATEADD(DAY, i % 365, '2009-01-01')
FROM n WHERE i <= 1000;

WITH n AS (SELECT TOP (5000) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS i
           FROM sys.all_columns a CROSS JOIN sys.all_columns b)
INSERT dbo.Tags (TagName, Count)
SELECT CONCAT(N'tag-', i), (i * 13) % 900
FROM n WHERE i <= 50;

WITH n AS (SELECT TOP (5000) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS i
           FROM sys.all_columns a CROSS JOIN sys.all_columns b)
INSERT dbo.PostLinks (Id, CreationDate, PostId, RelatedPostId, LinkTypeId)
SELECT i, DATEADD(DAY, i, '2009-06-01'), i % 1000 + 1, (i * 7) % 1000 + 1, CASE WHEN i % 5 = 0 THEN 3 ELSE 1 END
FROM n WHERE i <= 300;

WITH n AS (SELECT TOP (5000) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS i
           FROM sys.all_columns a CROSS JOIN sys.all_columns b)
INSERT lab.Run (Name, StartedAt, FinishedAt)
SELECT CONCAT(N'run ', i), DATEADD(HOUR, i, '2024-01-01'), DATEADD(MINUTE, i * 60 + 45, '2024-01-01')
FROM n WHERE i <= 20;

WITH n AS (SELECT TOP (5000) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS i
           FROM sys.all_columns a CROSS JOIN sys.all_columns b)
INSERT lab.History (RunId, CapturedAt, Metric, Value)
SELECT i % 20 + 1, DATEADD(MINUTE, i, '2024-01-01'), CHOOSE(i % 3 + 1, N'cpu', N'reads', N'duration_ms'), (i * 3) % 1000
FROM n WHERE i <= 500;
GO

-- One untrusted foreign key: added WITH NOCHECK, so SQL Server never checked the old rows.
ALTER TABLE dbo.Votes WITH NOCHECK ADD CONSTRAINT FK_Votes_Posts FOREIGN KEY (PostId) REFERENCES dbo.Posts (Id);
ALTER TABLE dbo.Badges ADD CONSTRAINT FK_Badges_Users FOREIGN KEY (UserId) REFERENCES dbo.Users (Id);

-- An index and its duplicate, for the index health tools.
CREATE NONCLUSTERED INDEX IX_Posts_OwnerUserId ON dbo.Posts (OwnerUserId);
CREATE NONCLUSTERED INDEX IX_Posts_OwnerUserId_Copy ON dbo.Posts (OwnerUserId);
GO

-- Queries without a useful index: they fill the plan cache and the missing-index DMVs.
-- Each has a join, so the optimizer goes past a trivial plan and records the missing index.
-- They run many times, because the tools hide suggestions with a small total benefit.
DECLARE @i INT = 0, @n INT;
WHILE @i < 300
BEGIN
  SELECT @n = COUNT(*) FROM dbo.Votes v JOIN dbo.Posts p ON p.Id = v.PostId WHERE v.UserId = @i % 1000 + 1;
  SELECT @n = COUNT(*) FROM dbo.Posts p JOIN dbo.Users u ON u.Id = p.OwnerUserId WHERE p.ParentId = @i % 1000 + 1;
  SET @i += 1;
END;
SELECT v.PostId, COUNT(*) AS VoteCount
FROM dbo.Votes v JOIN dbo.Posts p ON p.Id = v.PostId
WHERE v.UserId = 5 GROUP BY v.PostId;
SELECT p.Id, p.Title, u.DisplayName
FROM dbo.Posts p JOIN dbo.Users u ON u.Id = p.OwnerUserId
WHERE p.ParentId = 7 ORDER BY p.Score DESC;
SELECT c.Text, p.Title
FROM dbo.Comments c JOIN dbo.Posts p ON p.Id = c.PostId
WHERE c.UserId = 11 AND c.Score > 1;
SELECT b.Name, COUNT(*) AS Holders
FROM dbo.Badges b JOIN dbo.Users u ON u.Id = b.UserId
WHERE u.Location = N'Berlin' GROUP BY b.Name;
GO

-- One backup, so the backup history tools have a row.
BACKUP DATABASE [$(DbName)] TO DISK = N'/var/opt/mssql/data/$(DbName)-smoke.bak' WITH COPY_ONLY, INIT;
GO

-- One Agent job with a schedule; the setup script starts it once for job history.
USE [msdb];
GO
IF EXISTS (SELECT 1 FROM msdb.dbo.sysjobs WHERE name = N'$(DbName) smoke check')
  EXEC msdb.dbo.sp_delete_job @job_name = N'$(DbName) smoke check';
EXEC msdb.dbo.sp_add_job @job_name = N'$(DbName) smoke check';
EXEC msdb.dbo.sp_add_jobstep @job_name = N'$(DbName) smoke check', @step_name = N'Count posts',
  @subsystem = N'TSQL', @database_name = N'$(DbName)', @command = N'SELECT COUNT(*) FROM dbo.Posts;';
EXEC msdb.dbo.sp_add_jobschedule @job_name = N'$(DbName) smoke check', @name = N'Nightly',
  @freq_type = 4, @freq_interval = 1, @active_start_time = 20000;
EXEC msdb.dbo.sp_add_jobserver @job_name = N'$(DbName) smoke check', @server_name = N'(local)';
GO
