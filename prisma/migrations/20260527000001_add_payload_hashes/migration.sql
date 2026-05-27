-- AddColumn payload_hash to shipments
ALTER TABLE "shipments" ADD COLUMN "payload_hash" TEXT NOT NULL DEFAULT '';
UPDATE "shipments" SET "payload_hash" = "id";
ALTER TABLE "shipments" ALTER COLUMN "payload_hash" DROP DEFAULT;
CREATE UNIQUE INDEX "shipments_payload_hash_key" ON "shipments"("payload_hash");

-- AddColumn payload_hash to invoices
ALTER TABLE "invoices" ADD COLUMN "payload_hash" TEXT NOT NULL DEFAULT '';
UPDATE "invoices" SET "payload_hash" = "id";
ALTER TABLE "invoices" ALTER COLUMN "payload_hash" DROP DEFAULT;
CREATE UNIQUE INDEX "invoices_payload_hash_key" ON "invoices"("payload_hash");

-- AddColumn payload_hash to unclassified
ALTER TABLE "unclassified" ADD COLUMN "payload_hash" TEXT NOT NULL DEFAULT '';
UPDATE "unclassified" SET "payload_hash" = "id";
ALTER TABLE "unclassified" ALTER COLUMN "payload_hash" DROP DEFAULT;
CREATE UNIQUE INDEX "unclassified_payload_hash_key" ON "unclassified"("payload_hash");

-- CreateTable payload_hashes
CREATE TABLE "payload_hashes" (
    "hash" TEXT NOT NULL,
    "seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "payload_hashes_pkey" PRIMARY KEY ("hash")
);
