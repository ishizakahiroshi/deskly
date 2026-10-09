import { runContractSuite } from '../contract/run-contract-suite.mjs';
import { createSQLiteHarness } from './sqlite-harness.mjs';

// No filtering, overrides or omissions: exactly the same registrations as memory.
runContractSuite(createSQLiteHarness);
