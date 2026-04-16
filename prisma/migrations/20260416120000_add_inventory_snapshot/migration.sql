-- CreateTable
CREATE TABLE "InventorySnapshot" (
    "id" SERIAL NOT NULL,
    "snapshotDate" DATE NOT NULL,
    "shop" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "vendor" TEXT NOT NULL,
    "productType" TEXT NOT NULL,
    "tags" TEXT[],
    "status" TEXT NOT NULL,
    "totalQty" INTEGER NOT NULL,
    "stockValueCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "stockValueRetail" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "avgPrice" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventorySnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InventorySnapshot_snapshotDate_shop_productId_key" ON "InventorySnapshot"("snapshotDate", "shop", "productId");

-- CreateIndex
CREATE INDEX "InventorySnapshot_snapshotDate_shop_idx" ON "InventorySnapshot"("snapshotDate", "shop");

-- CreateIndex
CREATE INDEX "InventorySnapshot_snapshotDate_shop_vendor_idx" ON "InventorySnapshot"("snapshotDate", "shop", "vendor");

-- CreateIndex
CREATE INDEX "InventorySnapshot_snapshotDate_shop_status_idx" ON "InventorySnapshot"("snapshotDate", "shop", "status");
