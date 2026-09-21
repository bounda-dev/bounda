export const initialState = {
  status: "new" as "new" | "registered" | "active" | "expired",
  email: "",
  name: "",
  welcomeEmailSent: false,
};

export const aggregateId = "userId";
