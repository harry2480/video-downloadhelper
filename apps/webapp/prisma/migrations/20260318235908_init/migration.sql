-- CreateTable
CREATE TABLE "jokes" (
    "id" TEXT NOT NULL,
    "theme" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "jokes_pkey" PRIMARY KEY ("id")
);
