-- Session recording: remember, per session, whether it was recorded.
ALTER TABLE "sessions" ADD COLUMN "recorded" BOOLEAN NOT NULL DEFAULT false;
