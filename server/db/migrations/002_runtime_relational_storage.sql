CREATE TABLE IF NOT EXISTS migration_source_snapshots (
  collection TEXT PRIMARY KEY,
  payload JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF to_regclass('application_collections') IS NOT NULL THEN
    EXECUTE 'INSERT INTO migration_source_snapshots (collection, payload, updated_at)
      SELECT collection, payload, updated_at FROM application_collections
      ON CONFLICT (collection) DO NOTHING';
  END IF;
END;
$$;

ALTER TABLE wishlist_items DROP CONSTRAINT IF EXISTS wishlist_items_product_id_fkey;
ALTER TABLE wishlist_items ADD CONSTRAINT wishlist_items_product_id_fkey
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL;
