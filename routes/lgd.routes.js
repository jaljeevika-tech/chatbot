// GET /api/lgd/* — LGD location lookups (lib/lgdRouter.js).

import { getPool } from '../db/pool.js'
import { createLgdRouter } from '../lib/lgdRouter.js'

export default createLgdRouter(getPool)
