-- Keep venue-level meter loss separate from the unallocated remainder of shared meters.
-- Safe to re-run.
ALTER TABLE landlord_monthly_elec
    ADD COLUMN IF NOT EXISTS shared_unallocated_kwh NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE landlord_monthly_elec
    ADD COLUMN IF NOT EXISTS shared_unallocated_amount NUMERIC(14,2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN landlord_monthly_elec.loss_kwh IS
    'Venue loss = final_kwh - ref_kwh. Does not include a shared meter remainder.';
COMMENT ON COLUMN landlord_monthly_elec.shared_unallocated_kwh IS
    'Sum of shared meter full readings minus allocated brand kWh; separately borne by the company.';
