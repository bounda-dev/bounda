export const initialState = {
  status: "new" as "new" | "registered" | "active" | "expired",
  email: "",
  name: "",
  welcomeEmailRequested: false,
  welcomeEmailSent: false,
};

export const aggregateId = "userId";
