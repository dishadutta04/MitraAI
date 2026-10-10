from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    app_name: str = "Mitra AI Backend"
    app_version: str = "0.1.0"
    database_url: str = Field(default="sqlite:///./mitra_ai.db", alias="DATABASE_URL")
    redis_url: str = Field(default="redis://redis:6379/0", alias="REDIS_URL")
    llm_provider: str = Field(default="mock", alias="LLM_PROVIDER")
    openai_api_key: str | None = Field(default=None, alias="OPENAI_API_KEY")
    vosk_models_dir: str = Field(
        default=str(Path(__file__).resolve().parents[2] / "models"),
        alias="VOSK_MODELS_DIR",
    )
    # Clerk: sessions are verified against the instance's JWKS. The issuer is read from
    # CLERK_ISSUER, or worked out from the publishable key (pk_test_/pk_live_ + base64 domain).
    clerk_issuer: str | None = Field(default=None, alias="CLERK_ISSUER")
    clerk_publishable_key: str | None = Field(default=None, alias="CLERK_PUBLISHABLE_KEY")
    # Comma-separated origins allowed in the token's "azp" claim, e.g. http://localhost:3000
    clerk_authorized_parties: str = Field(default="http://localhost:3000", alias="CLERK_AUTHORIZED_PARTIES")

    # Razorpay (online payment). Test keys (rzp_test_...) take no real money.
    razorpay_key_id: str | None = Field(default=None, alias="RAZORPAY_KEY_ID")
    razorpay_key_secret: str | None = Field(default=None, alias="RAZORPAY_KEY_SECRET")

    # Order alerts. Email via Resend, SMS via Twilio; each channel is off until its keys are set.
    resend_api_key: str | None = Field(default=None, alias="RESEND_API_KEY")
    alert_email_from: str = Field(default="Mitra AI <onboarding@resend.dev>", alias="ALERT_EMAIL_FROM")
    twilio_account_sid: str | None = Field(default=None, alias="TWILIO_ACCOUNT_SID")
    twilio_auth_token: str | None = Field(default=None, alias="TWILIO_AUTH_TOKEN")
    twilio_from_number: str | None = Field(default=None, alias="TWILIO_FROM_NUMBER")


settings = Settings()
