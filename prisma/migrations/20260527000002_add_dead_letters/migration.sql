CREATE TABLE "dead_letters" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "job_id" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "error" TEXT,
    "retry_count" INTEGER NOT NULL,
    "failed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dead_letters_pkey" PRIMARY KEY ("id")
);
