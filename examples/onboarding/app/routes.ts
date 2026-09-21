import { index, type RouteConfig, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("register", "routes/register.tsx"),
  route("activate", "routes/activate.tsx"),
  route("users", "routes/users.tsx"),
  route("users/:userId", "routes/user.tsx"),
] satisfies RouteConfig;
