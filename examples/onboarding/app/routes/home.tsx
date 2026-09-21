import { Link } from "react-router";

export default function Home() {
  return (
    <section>
      <h1>User onboarding</h1>
      <p>
        A React Router app on Bounda. Registering a user starts the <code>user-onboarding</code>{" "}
        process: a welcome email goes out a minute later, and a registration that is not activated
        within a week expires.
      </p>
      <ol>
        <li>
          <Link to="/register">Register</Link> a user. The action dispatches{" "}
          <code>registerUser</code>.
        </li>
        <li>
          <Link to="/activate">Activate</Link> the registration, or let it expire.
        </li>
        <li>
          Browse the <Link to="/users">directory</Link>, a read model updated by projections.
        </li>
      </ol>
      <p className="muted">
        Storage is SQLite unless <code>DATABASE_URL</code> points at PostgreSQL. The welcome email
        goes to the console.
      </p>
    </section>
  );
}
