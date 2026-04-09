import { Link, Outlet, useLoaderData, useRouteError, useNavigation } from "@remix-run/react";
import { boundary } from "@shopify/shopify-app-remix/server";
import { AppProvider } from "@shopify/shopify-app-remix/react";
import { NavMenu } from "@shopify/app-bridge-react";
import { Spinner, Frame } from "@shopify/polaris";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";
import { authenticate } from "../shopify.server";

export const links = () => [{ rel: "stylesheet", href: polarisStyles }];

export const loader = async ({ request }) => {
  await authenticate.admin(request);

  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

function LoadingOverlay() {
  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 999,
      display: "flex", alignItems: "center", justifyContent: "center",
      background: "rgba(255,255,255,0.7)",
    }}>
      <Spinner size="large" />
    </div>
  );
}

export default function App() {
  const { apiKey } = useLoaderData();
  const navigation = useNavigation();
  const isLoading = navigation.state === "loading";

  return (
    <AppProvider isEmbeddedApp apiKey={apiKey}>
      <NavMenu>
        <Link to="/app" rel="home">Dashboard</Link>
        <Link to="/app/vendite">Vendite</Link>
        <Link to="/app/prodotti">Prodotti</Link>
        <Link to="/app/clienti">Clienti</Link>
        <Link to="/app/inventario">Inventario</Link>
        <Link to="/app/margini">Margini</Link>
        <Link to="/app/previsioni">Previsioni</Link>
      </NavMenu>
      {isLoading && <LoadingOverlay />}
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs Remix to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
