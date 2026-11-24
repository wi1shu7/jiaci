BEGIN;

ALTER TABLE "user_word_progress"
  ADD COLUMN "fsrs_state" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "due_at" TIMESTAMPTZ(3);

UPDATE "user_word_progress"
SET "fsrs_state" = CASE
      WHEN "status" = 'learning' AND "stability" IS NOT NULL AND "interval" = 0 THEN 3
      ELSE 2
    END,
    "due_at" = CASE
      WHEN "status" = 'learning' AND "stability" IS NOT NULL AND "interval" = 0
        THEN LEAST(CURRENT_TIMESTAMP, "updated_at" AT TIME ZONE 'UTC')
      ELSE NULL
    END
WHERE "status" <> 'new';

COMMENT ON COLUMN "user_word_progress"."fsrs_state" IS 'FSRS 卡片阶段：0 新卡 / 1 学习中 / 2 复习 / 3 重学';
COMMENT ON COLUMN "user_word_progress"."due_at" IS '短期重学的精确到期时间';

COMMIT;
