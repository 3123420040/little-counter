INSERT INTO app.permissions (id, description)
VALUES ('order:cancel_own', 'Cancel orders created by this operator in the authorized store')
ON CONFLICT (id) DO NOTHING;

INSERT INTO app.role_permissions (role, permission_id)
VALUES ('staff', 'order:cancel_own')
ON CONFLICT (role, permission_id) DO NOTHING;
