-- A deleted document may still be loaded in another instance's memory, and that instance's next
-- debounced store would insert the prose straight back. The row therefore outlives the delete as a
-- tombstone: readers see nothing, and a straggler's write is refused rather than racing it.
--
-- Additive and nullable, so the image before this one still reads the table.
ALTER TABLE "kern_collab"."documents" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;
