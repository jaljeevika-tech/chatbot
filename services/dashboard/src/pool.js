// The dashboard routes call getPool(); whoever mounts the router (the Cloud Run
// entry or the monolith fallback) supplies the real pool via usePool().
let _getPool = null
export const usePool = fn => { _getPool = fn }
export const getPool = () => _getPool()
