-- Dev only. Creates a second database for integration tests so test runs never
-- touch the dev data in "azaadawaaz". Runs once, on the first start of an
-- empty volume.
CREATE DATABASE azaadawaaz_test OWNER azaad;
