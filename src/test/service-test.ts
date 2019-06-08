import pg = require("pg");
import { init } from "../";
import request = require("supertest");
import { IDbConfig } from "psychopiggy";
import * as oauthAPIModule from "../api/oauth";
import * as githubModule from "../domain/oauth/github";
import * as userModule from "../domain/user";
import * as jwtModule from "../utils/jwt";
import { RouterContext } from "koa-router";

let app: any;

export default function run(dbConfig: IDbConfig, configDir: string) {
  describe("service", async () => {
    let app: any;

    before(async () => {
      const service = await init(configDir);
      app = service.listen();
    });

    it("says userid exists", async () => {
      const pool = new pg.Pool(dbConfig);
      await pool.query(`
        INSERT INTO "user"
          (id, first_name, last_name, created_at, updated_at)
          VALUES('jeswin', 'Jeswin', 'Kumar', ${Date.now()}, ${Date.now()});
      `);
      const response = await request(app).get("/user-ids/jeswin");
      response.status.should.equal(200);
      JSON.parse(response.text).should.deepEqual({
        exists: true
      });
    });

    it("says missing userid is missing", async () => {
      const response = await request(app).get("/user-ids/alice");
      response.status.should.equal(200);
      JSON.parse(response.text).should.deepEqual({
        exists: false
      });
    });

    it("redirects to connect", async () => {
      const response = await request(app).get(
        "/authenticate/github?success=http://test.example.com/success&newuser=http://test.example.com/newuser"
      );
      response.header["set-cookie"].should.containEql(
        "jwt-auth-service-success-redirect=http://test.example.com/success; path=/; domain=test.example.com"
      );
      response.header["set-cookie"].should.containEql(
        "jwt-auth-service-newuser-redirect=http://test.example.com/newuser; path=/; domain=test.example.com"
      );
      response.text.should.equal(
        `Redirecting to <a href="/connect/github">/connect/github</a>.`
      );
    });

    it("gets tokens", async () => {
      // Mock a few things.
      const realGetTokens = oauthAPIModule.getTokens;
      (oauthAPIModule as any).getTokens = async (
        ctx: RouterContext,
        provider: string
      ) => {
        ctx.session = { grant: { response: { access_token: "some_token" } } };
        return await realGetTokens(ctx, provider);
      };

      const realGetTokensByAccessToken = githubModule.getTokensByAccessToken;
      (githubModule as any).getTokensByAccessToken = async () => ({
        oauthSuccess: true,
        jwt: "some_jwt",
        tokens: { userId: "some_userid" }
      });
      const response = await request(app)
        .get("/oauth/token/github")
        .set("Cookie", [
          "jwt-auth-service-success-redirect=http://test.example.com/success",
          "jwt-auth-service-newuser-redirect=http://test.example.com/newuser"
        ]);

      (oauthAPIModule as any).getTokens = realGetTokens;
      (githubModule as any).getTokensByAccessToken = realGetTokensByAccessToken;

      const cookies = (response.header["set-cookie"] as Array<string>).flatMap(
        x => x.split(";")
      );
      cookies.should.containEql("jwt-auth-service-user-id=some_userid");
      cookies.should.containEql("jwt-auth-service-domain=test.example.com");
      response.text.should.equal(
        `Redirecting to <a href="http://test.example.com/newuser">http://test.example.com/newuser</a>.`
      );
    });

    it("creates a user", async () => {
      // Mock a few things.
      const realVerify = jwtModule.verify;
      (jwtModule as any).verify = () => ({
        valid: true,
        value: {
          providerUserId: "jeswin",
          provider: "github"
        }
      });

      const realCreateUser = userModule.createUser;
      (userModule as any).createUser = async () => ({
        created: true,
        jwt: "some_other_jwt",
        tokens: { userId: "jeswin" }
      });

      const response = await request(app)
        .post("/users")
        .send({ username: "jeswin" })
        .set("Cookie", ["jwt-auth-service-jwt=some_jwt"]);

      (jwtModule as any).verify = realVerify;
      (userModule as any).createUser = realCreateUser;

      const cookies = (response.header["set-cookie"] as Array<string>).flatMap(
        x => x.split(";")
      );
      cookies.should.containEql("jwt-auth-service-jwt=some_other_jwt");
      cookies.should.containEql("jwt-auth-service-domain=test.example.com");
      response.text.should.equal(
        `{"jwt-auth-service-jwt":"some_other_jwt","jwt-auth-service-user-id":"jeswin","jwt-auth-service-domain":"test.example.com"}`
      );
    });
  });
}
