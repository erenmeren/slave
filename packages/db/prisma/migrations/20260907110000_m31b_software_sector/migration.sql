-- M31b: a second sector. The `SimulationSector` enum was created with one value ('trade') by
-- M29's migration; the software sector is a plugin in `packages/simulation`, but the run row still
-- has to be able to SAY which sector it is. One added value, no table touched, no data moved.
ALTER TYPE "SimulationSector" ADD VALUE 'software';
