import os
import tempfile
import unittest
from contextlib import closing
from pathlib import Path


TEMP_DIR = tempfile.TemporaryDirectory()
os.environ["OKIMAP_DATABASE_PATH"] = str(Path(TEMP_DIR.name) / "okimap-test.db")
os.environ["OKIMAP_ALLOWED_ORIGINS"] = "https://okimap.wplaceoki.com"
os.environ["OKIMAP_SECURE_COOKIES"] = "false"
os.environ["OKIMAP_COOKIE_PATH"] = "/api"
os.environ["OKIMAP_ENVIRONMENT"] = "test"

import app as api  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402


ORIGIN_HEADERS = {"Origin": "https://okimap.wplaceoki.com"}


class CollaborationApiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client_context = TestClient(api.app)
        cls.client = cls.client_context.__enter__()
        timestamp = api.now_iso()
        users = [
            ("owner", "Owner", 0),
            ("other", "Other", 0),
            ("admin", "Admin", 1),
        ]
        with closing(api.connect_db()) as connection:
            connection.executemany(
                """
                insert into users
                  (discord_id, display_name, avatar_url, is_admin, created_at, updated_at)
                values (?, ?, null, ?, ?, ?)
                """,
                [(user_id, name, is_admin, timestamp, timestamp) for user_id, name, is_admin in users],
            )
            connection.commit()

    @classmethod
    def tearDownClass(cls):
        api.app.dependency_overrides.clear()
        cls.client_context.__exit__(None, None, None)
        TEMP_DIR.cleanup()

    def set_user(self, user_id: str):
        user = api.get_user_by_id(user_id)
        api.app.dependency_overrides[api.require_mutating_user] = lambda: user
        api.app.dependency_overrides[api.require_user] = lambda: user
        api.app.dependency_overrides[api.optional_user] = lambda: user

    def test_pin_comment_and_permissions(self):
        self.assertEqual(self.client.get("/api/pins").json(), [])

        self.set_user("owner")
        pin_payload = {
            "x": 120,
            "y": 240,
            "kind": "plan",
            "status": "open",
            "title": "港を整備",
            "body": "計画本文",
            "related_url": None,
        }
        response = self.client.post("/api/pins", json=pin_payload, headers=ORIGIN_HEADERS)
        self.assertEqual(response.status_code, 201, response.text)
        pin = response.json()
        self.assertEqual(pin["author"]["display_name"], "Owner")
        self.assertEqual(pin["favorite_count"], 0)
        self.assertFalse(pin["is_favorite"])

        bad_payload = {**pin_payload, "x": 15000}
        self.assertEqual(
            self.client.post("/api/pins", json=bad_payload, headers=ORIGIN_HEADERS).status_code,
            422,
        )

        self.set_user("other")
        response = self.client.patch(
            f"/api/pins/{pin['id']}", json={**pin_payload, "title": "横取り"}, headers=ORIGIN_HEADERS
        )
        self.assertEqual(response.status_code, 403)

        self.set_user("admin")
        response = self.client.patch(
            f"/api/pins/{pin['id']}",
            json={**pin_payload, "status": "in_progress"},
            headers=ORIGIN_HEADERS,
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["status"], "in_progress")

        self.set_user("other")
        response = self.client.post(
            f"/api/pins/{pin['id']}/favorite", headers=ORIGIN_HEADERS
        )
        self.assertEqual(response.status_code, 201, response.text)
        self.assertTrue(response.json()["is_favorite"])
        self.assertEqual(response.json()["favorite_count"], 1)
        self.assertTrue(self.client.get("/api/pins").json()[0]["is_favorite"])
        # 追加は冪等で、お気に入り件数が重複しない。
        self.assertEqual(
            self.client.post(
                f"/api/pins/{pin['id']}/favorite", headers=ORIGIN_HEADERS
            ).json()["favorite_count"],
            1,
        )

        self.set_user("owner")
        response = self.client.post(
            f"/api/pins/{pin['id']}/comments",
            json={"body": "着手します"},
            headers=ORIGIN_HEADERS,
        )
        self.assertEqual(response.status_code, 201, response.text)
        comment = response.json()

        self.set_user("other")
        notifications = self.client.get("/api/notifications").json()
        self.assertEqual(notifications["unread_count"], 1)
        self.assertEqual(notifications["notifications"][0]["comment_id"], comment["id"])
        notification_id = notifications["notifications"][0]["id"]
        self.assertEqual(
            self.client.patch(
                f"/api/notifications/{notification_id}/read", headers=ORIGIN_HEADERS
            ).status_code,
            200,
        )
        self.assertEqual(self.client.get("/api/notifications").json()["unread_count"], 0)
        self.assertEqual(
            self.client.delete(
                f"/api/pins/{pin['id']}/favorite", headers=ORIGIN_HEADERS
            ).json()["favorite_count"],
            0,
        )
        response = self.client.post(
            f"/api/pins/{pin['id']}/comments",
            json={"body": "確認をお願いします"},
            headers=ORIGIN_HEADERS,
        )
        self.assertEqual(response.status_code, 201, response.text)

        self.set_user("owner")
        owner_notifications = self.client.get("/api/notifications").json()
        self.assertEqual(owner_notifications["unread_count"], 1)
        self.assertEqual(owner_notifications["notifications"][0]["actor_id"], "other")
        self.assertEqual(
            self.client.post("/api/notifications/read-all", headers=ORIGIN_HEADERS).json()[
                "updated_count"
            ],
            1,
        )

        self.set_user("other")
        response = self.client.patch(
            f"/api/comments/{comment['id']}", json={"body": "横取り"}, headers=ORIGIN_HEADERS
        )
        self.assertEqual(response.status_code, 403)

        self.set_user("admin")
        self.assertEqual(
            self.client.delete(f"/api/comments/{comment['id']}", headers=ORIGIN_HEADERS).status_code,
            204,
        )
        self.assertEqual(
            self.client.delete(f"/api/pins/{pin['id']}", headers=ORIGIN_HEADERS).status_code,
            204,
        )
        self.assertEqual(self.client.get("/api/pins").json(), [])

    def test_public_session_and_origin_checks(self):
        api.app.dependency_overrides.clear()
        self.assertEqual(self.client.get("/api/health").json(), {"ok": True})
        cors_response = self.client.get("/api/pins", headers=ORIGIN_HEADERS)
        self.assertEqual(
            cors_response.headers.get("access-control-allow-origin"),
            "https://okimap.wplaceoki.com",
        )
        self.assertEqual(cors_response.headers.get("access-control-allow-credentials"), "true")
        self.assertIsNone(self.client.get("/api/auth/session").json()["user"])
        self.assertEqual(
            self.client.post(
                "/api/pins",
                json={
                    "x": 1,
                    "y": 1,
                    "kind": "question",
                    "status": "open",
                    "title": "ログインが必要",
                    "body": "",
                },
                headers=ORIGIN_HEADERS,
            ).status_code,
            401,
        )
        self.assertEqual(self.client.post("/api/auth/logout").status_code, 403)
        self.assertEqual(
            self.client.post("/api/auth/logout", headers=ORIGIN_HEADERS).status_code,
            204,
        )


if __name__ == "__main__":
    unittest.main()
