const AUTH_ERROR_MESSAGES = {
  email_address_invalid: "Enter a valid email address.",
  email_not_confirmed: "Confirm your email address before signing in.",
  invalid_credentials: "The email or password is incorrect.",
  over_email_send_rate_limit: "Too many email requests. Wait a moment and try again.",
  over_request_rate_limit: "Too many authentication attempts. Wait a moment and try again.",
  signup_disabled: "Account creation is currently unavailable.",
  user_already_exists: "An account with this email already exists. Try signing in instead.",
  user_already_registered: "An account with this email already exists. Try signing in instead.",
  weak_password: "Choose a stronger password and try again.",
};

export function getAuthErrorMessage(error, action = "sign in") {
  if (error?.name === "AuthRetryableFetchError" || error instanceof TypeError) {
    return "Unable to reach the authentication service. Check your connection and try again.";
  }

  if (error?.code && AUTH_ERROR_MESSAGES[error.code]) {
    return AUTH_ERROR_MESSAGES[error.code];
  }

  return `Unable to ${action}. Please try again.`;
}
