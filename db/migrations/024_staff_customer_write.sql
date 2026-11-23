-- 024_staff_customer_write.sql
-- Allow staff to perform customer write operations needed for POS checkout and customer management.

INSERT INTO app.permissions (id, description) VALUES
  ('customer:write', 'Create, update, delete, merge merchant customers, or send receipt emails')
ON CONFLICT (id) DO UPDATE SET description = EXCLUDED.description;

INSERT INTO app.role_permissions (role, permission_id) VALUES
  ('staff', 'customer:write')
ON CONFLICT (role, permission_id) DO NOTHING;
