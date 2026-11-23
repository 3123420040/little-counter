INSERT INTO app.permissions(id,description) VALUES
  ('partner:logs_read','Read scoped partner operational dashboard and redacted access logs'),
  ('partner:security_read','Read scoped partner security events with disclosure audit')
ON CONFLICT(id) DO NOTHING;
INSERT INTO app.role_permissions(role,permission_id) VALUES
  ('owner','partner:logs_read'),('owner','partner:security_read'),('manager','partner:logs_read')
ON CONFLICT DO NOTHING;
