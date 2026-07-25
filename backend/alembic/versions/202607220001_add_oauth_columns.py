"""OAuth / institutional sign-in support.

- users.password_hash → nullable (Google-only accounts have no password).
- users.google_sub (text, unique) → links a Google account by its subject id.

Revision ID: 202607220001
Revises: 202607200001
"""

import sqlalchemy as sa
from alembic import op

revision = "202607220001"
down_revision = "202607200001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column("users", "password_hash", existing_type=sa.Text(), nullable=True)
    op.add_column("users", sa.Column("google_sub", sa.Text(), nullable=True))
    op.create_unique_constraint("uq_users_google_sub", "users", ["google_sub"])


def downgrade() -> None:
    op.drop_constraint("uq_users_google_sub", "users", type_="unique")
    op.drop_column("users", "google_sub")
    # Best-effort: only valid if no NULL password rows remain (OAuth accounts).
    op.alter_column("users", "password_hash", existing_type=sa.Text(), nullable=False)
