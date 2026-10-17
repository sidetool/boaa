//! OS secure-store compatibility. Old entries stay readable if promotion fails.
use keyring::{Entry, Error};

pub(crate) fn get_secret(service: &str, account: &str) -> Result<Vec<u8>, Error> {
    crate::brand_compat::read_credential(
        service,
        account,
        |service, account| Entry::new(service, account)?.get_secret(),
        |service, account, value| Entry::new(service, account)?.set_secret(value),
        |error| matches!(error, Error::NoEntry),
    )
}

pub(crate) fn get_password(service: &str, account: &str) -> Result<String, Error> {
    crate::brand_compat::read_credential(
        service,
        account,
        |service, account| Entry::new(service, account)?.get_password(),
        |service, account, value| Entry::new(service, account)?.set_password(value),
        |error| matches!(error, Error::NoEntry),
    )
}

pub(crate) fn delete(service: &str, account: &str) -> Result<(), Error> {
    let mut first_error = None;
    for (service, account) in std::iter::once((service.to_owned(), account.to_owned()))
        .chain(crate::brand_compat::credential_aliases(service, account))
    {
        match Entry::new(&service, &account)?.delete_credential() {
            Ok(()) | Err(Error::NoEntry) => (),
            Err(error) => {
                if first_error.is_none() {
                    first_error = Some(error);
                }
            }
        }
    }
    first_error.map_or(Ok(()), Err)
}
