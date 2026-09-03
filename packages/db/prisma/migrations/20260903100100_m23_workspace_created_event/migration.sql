-- M23 A1: the first event a workspace ever logs. One enum member, nothing else touched.
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'workspace.created';
