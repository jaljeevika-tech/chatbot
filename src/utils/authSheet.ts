import Papa from 'papaparse';

export interface UserRow {
  name:         string;
  phone:        string;
  state:        string;
  role:         string;
  manager:      string;
  password?:    string;
  active?:      string;   // 'TRUE' | 'FALSE' | '' (empty = active)
  employee_id?: string;   // col H — unique employee ID
  designation?: string;   // col I — job title / designation
  project_ids?: string;   // col J — comma-separated project IDs assigned to this user
}

// Resolves null (not []) on failure so a transient error can't be mistaken for an empty sheet.
export async function fetchUsersFromSheet(spreadsheetId: string): Promise<UserRow[] | null> {
  const csvUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/gviz/tq?tqx=out:csv&sheet=Sheet1`;

  try {
    const response = await fetch(csvUrl);
    if (!response.ok) throw new Error('Failed to fetch user management sheet');

    const csvContent = await response.text();

    return new Promise((resolve, reject) => {
      Papa.parse(csvContent, {
        header: true,
        skipEmptyLines: true,
        complete: (results) => {
          const users: UserRow[] = results.data.map((row: any) => ({
            name:         String(row.Name        || '').trim(),
            phone:        String(row.Phone        || '').replace(/[\s\-]/g, '').replace(/^\+/, '').trim(),
            state:        String(row.State        || '').trim(),
            role:         String(row.Role         || '').trim(),
            manager:      String(row.Manager      || '').trim(),
            password:     String(row.Password     || '').trim(),
            active:       String(row.Active       || '').trim(),
            employee_id:  String(row.Employee_ID  || '').trim(),
            designation:  String(row.Designation  || '').trim(),
            project_ids:  String(row.Project_IDs  || '').trim(),
          }));
          resolve(users);
        },
        error: (error: any) => reject(error),
      });
    });
  } catch (err) {
    console.error('Error fetching users:', err);
    return null;
  }
}
