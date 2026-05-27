-- CreateTable
CREATE TABLE "shipments" (
    "id" TEXT NOT NULL,
    "vendor_event_id" TEXT NOT NULL,
    "tracking_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "status_rank" INTEGER NOT NULL,
    "carrier" TEXT,
    "location" TEXT,
    "event_time" TIMESTAMP(3) NOT NULL,
    "raw_payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shipments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" TEXT NOT NULL,
    "vendor_event_id" TEXT NOT NULL,
    "invoice_ref" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "status_rank" INTEGER NOT NULL,
    "carrier" TEXT,
    "amount_raw" TEXT,
    "currency" TEXT,
    "event_time" TIMESTAMP(3) NOT NULL,
    "raw_payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "unclassified" (
    "id" TEXT NOT NULL,
    "raw_payload" JSONB NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "unclassified_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "shipments_vendor_event_id_key" ON "shipments"("vendor_event_id");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_vendor_event_id_key" ON "invoices"("vendor_event_id");
