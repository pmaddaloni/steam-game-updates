import axios from 'axios';
import './App.scss';
import { AuthProvider } from './AuthContext.js';
import Body from './body/AppBody.js';
import Header from './header/Header.js';

// https://create-react-app.dev/docs/adding-custom-environment-variables/#adding-development-environment-variables-in-env
axios.defaults.baseURL = window.location.host.includes('steamgameupdates.info') ?
  'https://steamgameupdates.info' :
  (process.env.REACT_APP_LOCALHOST || 'http://localhost') +
  (process.env.REACT_APP_LOCALHOST_PORT || ':8080');
axios.defaults.withCredentials = true;
axios.defaults.maxRedirects = 0; // Set to 0 to prevent automatic redirects
axios.interceptors.response.use(
  response => response,
  error => {
    if (error.response && [301, 302].includes(error.response.status)) {
      const redirectUrl = error.response.headers.location;
      return axios[error.config.method](redirectUrl);
    }
    return Promise.reject(error);
  }
);

function App() {
  return (
    <AuthProvider>
      <div className="App">
        <Header />
        <Body />
      </div>
    </AuthProvider>
  );
}

export default App;
