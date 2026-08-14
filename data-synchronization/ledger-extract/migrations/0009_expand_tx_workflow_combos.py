from typing import Any


def upgrade(client: Any) -> None:
    with client.cursor() as cursor:
        cursor.execute("""
            ALTER TABLE category_master
                DROP CONSTRAINT chk_cm_tx_workflow_combo,
                ADD CONSTRAINT chk_cm_tx_workflow_combo CHECK (
                    (tx_type = 'money-in'       AND workflow_type = 'account-credit') OR
                    (tx_type = 'money-out'      AND workflow_type IN ('account-debit', 'debt-repayment')) OR
                    (tx_type = 'money-transfer' AND workflow_type IN ('funds-transfer', 'forex-transfer', 'debt-repayment'))
                );
        """)
    client.commit()
