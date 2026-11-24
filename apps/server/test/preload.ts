import { afterEach, setDefaultTimeout } from "bun:test";
import { runCleanups } from "./harness";

// O primeiro teste do processo migra o template do PGlite (~0,6 s).
setDefaultTimeout(30_000);

afterEach(runCleanups);
